-- Admin-editable platform settings (starting with the opt-in cloud smart
-- tier's API key), stored in the database instead of an env file so an
-- admin can configure them entirely from the Control Center -- no
-- terminal, no SSH, no editing platform/.env by hand. A plain key/value
-- table rather than dedicated columns per setting: this is the mechanism
-- future admin-configurable settings reuse too, not just this one key.

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage platform settings" ON public.platform_settings;
CREATE POLICY "Admins can manage platform settings" ON public.platform_settings
  TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_settings TO authenticated;
