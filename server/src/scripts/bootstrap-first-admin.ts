import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../.env', import.meta.url) });

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('Set NODE_ENV=production explicitly before running first-admin bootstrap.');
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD in the deployment secret store.');
  }

  const [{ prisma }, { bootstrapFirstAdmin }] = await Promise.all([
    import('../config/prisma.js'),
    import('../services/admin/bootstrap-first-admin.js'),
  ]);
  try {
    await bootstrapFirstAdmin(prisma, { email, password });
    console.info('First CivicLoop administrator provisioned. Remove the bootstrap credentials from the environment.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ADMIN_EXISTS') {
    console.error('Bootstrap refused: an administrator already exists.');
  } else if (error && typeof error === 'object' && 'code' in error && error.code === 'EMAIL_IN_USE') {
    console.error('Bootstrap refused: the configured email already belongs to an account.');
  } else if (error instanceof Error && error.message.startsWith('Set ')) {
    console.error(error.message);
  } else if (error instanceof Error && error.message.startsWith('Bootstrap email')) {
    console.error(error.message);
  } else {
    console.error('Bootstrap failed. Check database connectivity and server configuration without exposing credentials.');
  }
  process.exitCode = 1;
});
