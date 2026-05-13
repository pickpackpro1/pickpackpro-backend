import { Prisma } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const defaultSettings = {
  working_days: {
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: false,
    sunday: false,
  },
  dispatch_lead_time_hours: 72,
  company_name: "",
  company_address: {},
  vat_number: null as string | null,
  bank_details: {},
  notification_toggles: {},
};

const schema = z.object({
  workingDays: z.record(z.boolean()).optional(),
  dispatchLeadTimeHours: z.number().int().min(1).optional(),
  companyName: z.string().optional(),
  companyAddress: z.record(z.unknown()).optional(),
  vatNumber: z.string().optional().nullable(),
  bankDetails: z.record(z.unknown()).optional(),
  resendApiKey: z.string().optional().nullable(),
  sendingDomain: z.string().optional().nullable(),
  notificationToggles: z.record(z.boolean()).optional(),
});

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const settings = await prisma.app_settings.findFirst();
    return success(settings ?? defaultSettings);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    const existing = await prisma.app_settings.findFirst();
    const data = {
      working_days: body.workingDays as Prisma.InputJsonValue | undefined,
      dispatch_lead_time_hours: body.dispatchLeadTimeHours,
      company_name: body.companyName,
      company_address: body.companyAddress as Prisma.InputJsonValue | undefined,
      vat_number: body.vatNumber,
      bank_details: body.bankDetails as Prisma.InputJsonValue | undefined,
      resend_api_key: body.resendApiKey,
      sending_domain: body.sendingDomain,
      notification_toggles: body.notificationToggles as Prisma.InputJsonValue | undefined,
      updated_at: new Date(),
    };

    const settings = existing
      ? await prisma.app_settings.update({ where: { id: existing.id }, data })
      : await prisma.app_settings.create({
          data: {
            working_days: (body.workingDays ?? defaultSettings.working_days) as Prisma.InputJsonValue,
            dispatch_lead_time_hours: body.dispatchLeadTimeHours ?? defaultSettings.dispatch_lead_time_hours,
            company_name: body.companyName ?? defaultSettings.company_name,
            company_address: (body.companyAddress ?? defaultSettings.company_address) as Prisma.InputJsonValue,
            vat_number: body.vatNumber ?? defaultSettings.vat_number,
            bank_details: (body.bankDetails ?? defaultSettings.bank_details) as Prisma.InputJsonValue,
            resend_api_key: body.resendApiKey ?? null,
            sending_domain: body.sendingDomain ?? null,
            notification_toggles: (body.notificationToggles ?? defaultSettings.notification_toggles) as Prisma.InputJsonValue,
            updated_at: new Date(),
          },
        });

    return success(settings);
  } catch (err) {
    return handleApiError(err);
  }
}
