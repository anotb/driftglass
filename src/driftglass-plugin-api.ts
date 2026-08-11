import {
  driftglassPluginZip,
  parseDriftglassPluginAppId,
} from "./driftglass-plugin";
import { requireAdmin } from "./security";
import { HttpError, readJson } from "./utils";

export async function driftglassPluginDownloadResponse(
  request: Request,
  ownerSecret: string,
): Promise<Response> {
  await requireAdmin(request, ownerSecret);
  const body = await readJson<Record<string, unknown>>(request, 2_048);
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !("appId" in body)
  ) {
    throw new HttpError(400, "The request must contain only appId.");
  }
  let appId: string;
  try {
    appId = parseDriftglassPluginAppId(body.appId);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid ChatGPT technical app ID");
  }
  return new Response(driftglassPluginZip(appId) as unknown as BodyInit, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="driftglass-plugin.zip"',
      "cache-control": "no-store",
    },
  });
}
