-- ================================================================
-- 회원탈퇴 RPC 함수
-- ================================================================
-- 클라이언트에서 auth.users 직접 삭제 불가 → SECURITY DEFINER 함수로 우회
-- 호출: supabase.rpc('delete_own_account')
--
-- 실행 순서:
--   1. 사용자 본인 확인 (auth.uid())
--   2. 공개 테이블 데이터 삭제 (CASCADE로 대부분 자동 처리되지만 명시)
--   3. auth.users 레코드 삭제 → 연쇄적으로 auth 세션/토큰 모두 무효화
-- ================================================================

CREATE OR REPLACE FUNCTION public.delete_own_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  _uid uuid;
BEGIN
  -- 1. 현재 인증된 유저 ID 확인
  _uid := auth.uid();

  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 2. 구독 정보 삭제 (RevenueCat 정보 포함)
  DELETE FROM public.subscriptions WHERE user_id = _uid;

  -- 3. 알림 이력 삭제
  DELETE FROM public.notifications WHERE user_id = _uid;

  -- 4. 관심 단지 삭제
  DELETE FROM public.user_interests WHERE user_id = _uid;

  -- 5. 프로필 삭제 (FCM 토큰, 가점 정보 등)
  DELETE FROM public.user_profiles WHERE user_id = _uid;

  -- 6. auth.users 삭제 (세션·토큰 전부 자동 무효화)
  DELETE FROM auth.users WHERE id = _uid;
END;
$$;

-- 실행 권한: authenticated 유저만
REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;

-- ================================================================
-- 적용 방법 (Supabase SQL Editor 또는 CLI)
-- ================================================================
-- supabase db push  또는
-- Supabase Dashboard → SQL Editor → 위 내용 붙여넣기 후 실행
