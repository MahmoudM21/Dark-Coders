CREATE TABLE public.user_state (
  user_id uuid NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_state TO authenticated;
GRANT ALL ON public.user_state TO service_role;
ALTER TABLE public.user_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own state select" ON public.user_state FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own state insert" ON public.user_state FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own state update" ON public.user_state FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own state delete" ON public.user_state FOR DELETE TO authenticated USING (auth.uid() = user_id);