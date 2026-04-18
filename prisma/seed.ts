import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const count = await prisma.person.count();
  if (count > 0) {
    console.log('База уже содержит данные, seed пропущен.');
    return;
  }
  console.log('База пуста. Seed ничего не добавляет — заводите данные через UI.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
