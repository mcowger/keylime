import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelRoles, writeModelRoles } from "@/lib/omp/model-roles";

/**
 * @apiContract getModelRoles
 * @apiUsage Read configured native model roles.
 * @apiInputs No workspace is selected.
 * @apiInvariants This is a user configuration read, not live session state.
 * @apiEffects Reads configuration without mutation.
 * @apiRecovery Correct configuration errors and retry the read.
 */
export function GET() {
  try {
    return Response.json(readModelRoles());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

/**
 * @apiContract putModelRoles
 * @apiUsage Replace the configured model-role mapping.
 * @apiInputs Supply roles as an object; only nonblank string keys and values are retained.
 * @apiInvariants The roles map is replaced, not merged entry by entry.
 * @apiEffects Writes native configuration and invalidates the models cache.
 * @apiRecovery Read roles after an uncertain response before retrying.
 */
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { roles?: unknown };
    if (
      !body.roles ||
      typeof body.roles !== "object" ||
      Array.isArray(body.roles)
    ) {
      return Response.json(
        { error: "roles must be an object" },
        { status: 400 },
      );
    }
    const roles = Object.fromEntries(
      Object.entries(body.roles).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          entry[0].trim().length > 0 &&
          entry[1].trim().length > 0,
      ),
    );
    writeModelRoles(roles);
    invalidateModelsCache();
    return Response.json({ success: true, roles });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
