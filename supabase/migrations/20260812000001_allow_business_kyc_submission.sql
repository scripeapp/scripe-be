BEGIN;

DROP POLICY IF EXISTS "business members submit kyc" ON public.kyc_verifications;
CREATE POLICY "business members submit kyc" ON public.kyc_verifications
  FOR INSERT
  WITH CHECK (is_business_member(business_id));

DROP POLICY IF EXISTS "business members read kyc" ON public.kyc_verifications;
CREATE POLICY "business members read kyc" ON public.kyc_verifications
  FOR SELECT
  USING (is_business_member(business_id));

COMMIT;
