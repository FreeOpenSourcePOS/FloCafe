'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Public self-service registration is not supported in this desktop build —
 * first-run setup creates the owner account through /setup (see
 * /api/auth/setup/initialize). Redirect this stale route there instead of
 * presenting a form that posts to a non-existent endpoint (issue #229).
 */
export default function RegisterPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/setup');
  }, [router]);

  return null;
}
