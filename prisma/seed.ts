import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Injection des catégories par défaut...');

  // Nettoyage optionnel
  await prisma.category.deleteMany({});

  const categories = [
    { name: 'Électronique & High-Tech', slug: 'electronique-high-tech', icon: 'Smartphone', order: 1 },
    { name: 'Mode & Vêtements', slug: 'mode-vetements', icon: 'Shirt', order: 2 },
    { name: 'Maison & Cuisine', slug: 'maison-cuisine', icon: 'Home', order: 3 },
    { name: 'Téléphonie & Accessoires', slug: 'telephonie-accessoires', icon: 'Phone', order: 4 },
    { name: 'Beauté & Santé', slug: 'beaute-sante', icon: 'Heart', order: 5 },
  ];

  for (const cat of categories) {
    await prisma.category.create({ data: cat });
  }

  console.log('✅ Catégories injectées avec succès !');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });