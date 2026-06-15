import { PricingType, PrismaClient, UnitType } from "@prisma/client";

const prisma = new PrismaClient();

const services = [
  {
    code: "fnsku_label",
    display: "FNSKU Labelling",
    unitType: UnitType.per_unit,
    pricingType: PricingType.tiered,
    pricing: { platinum: 0.28 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "polybag",
    display: "Polybag",
    unitType: UnitType.per_unit,
    pricingType: PricingType.flat,
    pricing: { rate: 0.05 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "bundling",
    display: "Bundling",
    unitType: UnitType.per_unit,
    pricingType: PricingType.flat,
    pricing: { rate: 0.05 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "bubble_wrap",
    display: "Bubble Wrap",
    unitType: UnitType.per_unit,
    pricingType: PricingType.flat,
    pricing: { rate: 0.1 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "leaflet_insertion",
    display: "Marketing Leaflet Insertion",
    unitType: UnitType.per_unit,
    pricingType: PricingType.flat,
    pricing: { rate: 0.1 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "oversize_surcharge",
    display: "Oversize Items",
    unitType: UnitType.per_unit,
    pricingType: PricingType.flat,
    pricing: { rate: 0.7 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "medium_box",
    display: "Medium Box",
    unitType: UnitType.per_box,
    pricingType: PricingType.flat,
    pricing: { rate: 2 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "large_box",
    display: "Large Box",
    unitType: UnitType.per_box,
    pricingType: PricingType.flat,
    pricing: { rate: 2.5 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "return_processing",
    display: "Return Processing",
    unitType: UnitType.per_unit,
    pricingType: PricingType.flat,
    pricing: { rate: 0.5 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "pallet_forwarding",
    display: "Pallet Forwarding",
    unitType: UnitType.per_pallet,
    pricingType: PricingType.flat,
    pricing: { rate: 10 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "box_forwarding",
    display: "Only Box Forwarding",
    unitType: UnitType.per_box,
    pricingType: PricingType.flat,
    pricing: { rate: 3 },
    vatApplicable: true,
    billable: true,
  },
  {
    code: "pallet_storage",
    display: "Pallet Storage",
    unitType: UnitType.per_cbm_week,
    pricingType: PricingType.flat,
    pricing: { rate: 5.99 },
    vatApplicable: true,
    billable: false,
  },
  {
    code: "box_receiving_forwarding",
    display: "Box Receiving and Forwarding",
    unitType: UnitType.flat,
    pricingType: PricingType.flat,
    pricing: { rate: 0 },
    vatApplicable: false,
    billable: false,
  },
  {
    code: "shipping_label_charge",
    display: "Shipping Label Charges",
    unitType: UnitType.flat,
    pricingType: PricingType.flat,
    pricing: { rate: 0 },
    vatApplicable: false,
    billable: false,
  },
];

async function main() {
  for (const [index, service] of services.entries()) {
    await prisma.service_catalog.upsert({
      where: { code: service.code },
      update: {
        display_name: service.display,
        unit_type: service.unitType,
        pricing_type: service.pricingType,
        default_tier_pricing: service.pricing,
        vat_applicable: service.vatApplicable,
        billable: service.billable,
        active: true,
        sort_order: index + 1,
      },
      create: {
        code: service.code,
        display_name: service.display,
        unit_type: service.unitType,
        pricing_type: service.pricingType,
        default_tier_pricing: service.pricing,
        vat_applicable: service.vatApplicable,
        billable: service.billable,
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
