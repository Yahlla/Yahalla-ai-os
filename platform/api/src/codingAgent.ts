// Server-side coding agent: given a repo + a natural-language instruction,
// this actually explores real files (via the GitHub Contents API) and
// commits a real change (via githubCommit.ts's Git Data API pipeline) --
// entirely from this server, over the GitHub API, with zero local device
// or local git clone involved anywhere. This is the platform-owner-level
// equivalent of local-runtime's agentLoop.ts coding loop, for the case
// where nothing runs on the user's own machine at all.

import Anthropic from '@anthropic-ai/sdk'
import { commitFilesAndOpenPr, listRepoDir, readRepoFile, type CommitAndPrResult } from './githubCommit.js'

const SYSTEM_PROMPT = `You are Yahalla Core's cloud coding agent. You make real code changes directly to a GitHub repository through its API -- there is no local machine, no git clone, no filesystem of your own. You only ever see the repository through the list_files and read_file tools.

Work like this:
1. Explore with list_files/read_file until you understand enough of the relevant code to make a correct, complete change. Don't over-explore -- read only what the task actually requires.
2. When you are ready, call propose_commit exactly once with every file you are creating or modifying, a clear commit message, and a PR title/description. This is the only way you can actually ship a change -- there is no separate "write file" step.
3. Keep the change scoped to what was asked. Don't refactor, rename, or "clean up" code the task didn't ask you to touch.
4. Pick a short, descriptive, kebab-case branch name (e.g. "fix-login-redirect", not "patch-1").
5. If propose_commit fails, read the error and fix the problem (e.g. a stale branch), then call it again.`

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_files',
    description: 'List files and directories at a path in the repository (empty string or "/" for the repo root).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path, relative to the repo root. Empty string for the root.' } },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full current content of one file in the repository.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path, relative to the repo root.' } },
      required: ['path'],
    },
  },
  {
    name: 'propose_commit',
    description:
      'Ship the change: creates a branch, commits every listed file as one atomic commit, and opens a pull request. Call this exactly once, only when you are done editing.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Short kebab-case branch name.' },
        commit_message: { type: 'string' },
        pr_title: { type: 'string' },
        pr_body: { type: 'string' },
        files: {
          type: 'array',
          description: 'Every file to create or update, with its full final content (not a diff).',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
      required: ['branch', 'commit_message', 'pr_title', 'files'],
    },
  },
]

export type CodingAgentResult =
  | { ok: true; summary: string; pullRequest?: NonNullable<Extract<CommitAndPrResult, { ok: true }>['pullRequest']> }
  | { ok: false; error: string }

export async function runCodingAgent(
  cloud: { apiKey: string; model: string; baseURL?: string },
  github: { token: string },
  args: { owner: string; repo: string; base?: string; instruction: string },
  maxIterations = 12,
): Promise<CodingAgentResult> {
  const client = new Anthropic({ apiKey: cloud.apiKey, baseURL: cloud.baseURL })
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Repository: ${args.owner}/${args.repo}\nBase branch: ${args.base ?? 'main'}\n\nTask: ${args.instruction}`,
    },
  ]

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response: Anthropic.Message
    try {
      response = await client.messages.create({
        model: cloud.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      })
    } catch (error) {
      return { ok: false, error: error instanceof Anthropic.APIError ? `Claude error: ${error.message}` : error instanceof Error ? error.message : 'Coding agent request failed.' }
    }

    if (response.stop_reason === 'refusal') {
      return { ok: false, error: 'Claude declined this task (safety classifier).' }
    }

    messages.push({ role: 'assistant', content: response.content })

    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    if (toolUses.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return { ok: true, summary: text || 'The agent finished without proposing a commit.' }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      if (use.name === 'propose_commit') {
        const input = use.input as { branch: string; commit_message: string; pr_title: string; pr_body?: string; files: { path: string; content: string }[] }
        const commitResult = await commitFilesAndOpenPr(github.token, {
          owner: args.owner,
          repo: args.repo,
          base: args.base,
          branch: input.branch,
          files: input.files,
          commitMessage: input.commit_message,
          prTitle: input.pr_title,
          prBody: input.pr_body,
        })
        if (!commitResult.ok) {
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: `Commit failed: ${commitResult.error}`, is_error: true })
          continue
        }
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'Committed and pull request opened.' }] })
        return {
          ok: true,
          summary: `Opened pull request #${commitResult.pullRequest.number}: ${commitResult.pullRequest.title} — ${commitResult.pullRequest.html_url}`,
          pullRequest: commitResult.pullRequest,
        }
      }
      if (use.name === 'list_files') {
        const input = use.input as { path?: string }
        const result = await listRepoDir(github.token, args.owner, args.repo, input.path ?? '', args.base)
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: result.ok ? JSON.stringify(result.entries) : `Error: ${result.error}`, is_error: !result.ok })
        continue
      }
      if (use.name === 'read_file') {
        const input = use.input as { path: string }
        const result = await readRepoFile(github.token, args.owner, args.repo, input.path, args.base)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: result.ok ? (result.content ?? '(file does not exist yet)') : `Error: ${result.error}`,
          is_error: !result.ok,
        })
        continue
      }
      toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown tool "${use.name}".`, is_error: true })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return { ok: false, error: `Gave up after ${maxIterations} tool-use iterations without proposing a commit.` }
}
