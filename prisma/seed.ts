import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const services = [
  { code: "FNSKU_LABEL", display: "FNSKU Label", pricing: { silver: 0.2, gold: 0.18, platinum: 0.15 } },
  { code: "POLY_BAG", display: "Poly Bag", pricing: { silver: 0.25, gold: 0.22, platinum: 0.18 } },
  { code: "BUBBLE_WRAP", display: "Bubble Wrap", pricing: { silver: 0.3, gold: 0.27, platinum: 0.22 } },
  { code: "BUNDLING", display: "Bundling", pricing: { silver: 0.15, gold: 0.13, platinum: 0.1 } },
];

async function main() {
  for (const [index, service] of services.entries()) {
    await prisma.service_catalog.upsert({
      where: { code: service.code },
      update: { default_tier_pricing: service.pricing, active: true, billable: true },
      create: {
        code: service.code,
        display_name: service.display,
        unit_type: "per_unit",
        pricing_type: "tiered",
        default_tier_pricing: service.pricing,
        vat_applicable: false,
        billable: true,
        active: true,
        sort_order: index + 1,
      },
    });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    await prisma.users.upsert({
      where: { email: adminEmail },
      update: { role: "admin", active: true },
      create: {
        email: adminEmail,
        full_name: process.env.ADMIN_NAME ?? "Default Admin",
        role: "admin",
      },
    });
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
