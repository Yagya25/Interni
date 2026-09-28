import { handleRead, handleStatus } from "@/features/workspace/agent/server/handler";

export const dynamic = "force-dynamic";

/** Whether the design agent is configured, and with which model. No secrets. */
export function GET() {
  return handleStatus();
}

/** Read one request with the design agent. Off (404) unless configured. */
export function POST(request: Request) {
  return handleRead(request);
}
