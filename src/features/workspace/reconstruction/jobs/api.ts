import { RUN_ID } from "../localRuns";
import { jobConfig, type JobConfig } from "./config";
import { queueFor, type JobQueue } from "./queue";
import { validateUpload } from "./validate";

/**
 * The two job endpoints. Like the rest of /api/reconstructions/local they
 * exist only where DATUM_RECONSTRUCTION_RUNS is set. Every answer is a
 * status and a code: no path, log line or setting ever leaves the server.
 */

const noStore = { "Cache-Control": "no-store" };

function problem(status: number, code: string) {
  return Response.json({ code }, { status, headers: noStore });
}

type Resolve = () => { config: JobConfig; queue: JobQueue } | null;

const fromEnvironment: Resolve = () => {
  const config = jobConfig();
  return config ? { config, queue: queueFor(config) } : null;
};

export async function enqueueUpload(request: Request, resolve: Resolve = fromEnvironment): Promise<Response> {
  const found = resolve();
  if (!found) return problem(404, "not-configured");
  const { config, queue } = found;

  // Refuse an oversized body before reading it (multipart adds a little framing).
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > config.maxBytes + 64 * 1024) return problem(413, "too-large");

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("photo");
  } catch {
    return problem(400, "upload-invalid");
  }
  if (!file || typeof file === "string") return problem(400, "upload-invalid");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = validateUpload(bytes, file.type, config.maxBytes);
  if (!checked.ok) return problem(checked.status, checked.code);

  try {
    const result = await queue.enqueue(bytes, checked.kind);
    if (!result.ok) return problem(result.status, result.code);
    return Response.json(result.view, { status: 202, headers: noStore });
  } catch (error) {
    console.error("[reconstruction-job] the upload could not be recorded:", error);
    return problem(500, "upload-failed");
  }
}

export async function jobStatus(runId: string, resolve: Resolve = fromEnvironment): Promise<Response> {
  const found = resolve();
  if (!found) return problem(404, "not-configured");
  if (!RUN_ID.test(runId)) return problem(404, "not-found");
  const view = await found.queue.status(runId);
  return view ? Response.json(view, { headers: noStore }) : problem(404, "not-found");
}
