import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { bootstrapFirstAdmin } from '../src/services/admin/bootstrap-first-admin.js';

const prisma = new PrismaClient();

async function main() {
  const enabled = process.env.BOOTSTRAP_ADMIN_ENABLED === 'true';
  const allowedEnvironment = process.env.NODE_ENV !== 'production';
  if (enabled && allowedEnvironment) {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password) throw new Error('Bootstrap admin requires BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD');
    await bootstrapFirstAdmin(prisma, { email, password });
  }

  const departments = [
    ['Roads & Infrastructure', 'ROADS', 'Road maintenance and infrastructure works'],
    ['Sanitation & Waste Management', 'WASTE', 'Waste collection and sanitation'],
    ['Water Supply', 'WATER', 'Public water supply'],
    ['Drainage & Flood Management', 'DRAINAGE', 'Drainage and flood response'],
    ['Electricity & Street Lighting', 'ELECTRICITY', 'Public electrical systems'],
    ['Public Safety', 'PUBLIC_SAFETY', 'Public safety coordination'],
    ['Parks & Public Spaces', 'PARKS', 'Parks and public amenities'],
  ] as const;

  for (const [name, code, description] of departments) {
    await prisma.department.upsert({
      where: { code },
      update: { name, description, status: 'ACTIVE' },
      create: { name, code, description, status: 'ACTIVE' },
    });
  }

  console.log(`Seeded ${departments.length} synthetic departments`);
  if (enabled && allowedEnvironment) console.log('Development bootstrap administrator provisioned');
}

main().finally(() => prisma.$disconnect());
