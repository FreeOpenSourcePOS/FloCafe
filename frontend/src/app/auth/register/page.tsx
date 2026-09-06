'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Redirect to /setup since self-service registration is handled during first-run setup. */
export default function RegisterPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/setup');
  }, [router]);

  return null;
}
