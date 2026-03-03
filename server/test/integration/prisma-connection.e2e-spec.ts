import { PrismaClient } from '@prisma/client';

describe('Prisma DB connection', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('connects to DB and runs a simple query', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ result: number }>>(
      'SELECT 1 as result',
    );

    expect(Number(rows[0]?.result)).toBe(1);
  });
});
