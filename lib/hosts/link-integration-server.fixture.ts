import { GET as configFile } from "../../app/api/hosts/cluster-config/file/[hash]/route.ts";
import { GET as configManifest } from "../../app/api/hosts/cluster-config/manifest/route.ts";
import * as link from "../../app/api/hosts/link/route.ts";
import { startRpcSession } from "../rpc-manager.ts";
import { saveWebServerSettings } from "../web-settings.ts";
import { getHost, hostLinkSocket, type LinkSocketData } from "./hub.ts";
import { createHost } from "./registry.ts";

const [projectDir, marker] = process.argv.slice(2);
saveWebServerSettings({ agentEnv: { LINK_TEST_MARKER: marker } });
const { host, token } = createHost(marker);
const online = Promise.withResolvers<void>();
const server: Bun.Server<LinkSocketData> = Bun.serve<LinkSocketData>({
  hostname: "127.0.0.1",
  port: 0,
  routes: {
    "/api/hosts/cluster-config/manifest": { GET: configManifest },
    "/api/hosts/cluster-config/file/:hash": {
      GET: (req: Bun.BunRequest<"/api/hosts/cluster-config/file/:hash">) =>
        configFile(req, { params: Promise.resolve(req.params) }),
    },
    "/api/hosts/link": {
      GET: (req: Request) =>
        link.GET(req, { upgrade: (data) => server.upgrade(req, { data }) }),
      POST: link.POST,
    },
    "/launch": {
      async POST() {
        await online.promise;
        const remote = getHost(host.id);
        if (!remote) return new Response("Host not linked", { status: 503 });
        try {
          const registration = await remote.workspaceOps.hierarchy({
            action: "registerProject",
            path: projectDir,
          });
          if (!registration.ok)
            return Response.json(registration, { status: 500 });
          const { realSessionId } = await startRpcSession(
            "",
            "",
            projectDir,
            undefined,
            false,
            null,
            undefined,
            remote,
          );
          return Response.json({ sessionId: realSessionId });
        } catch (error) {
          return new Response(String(error), { status: 500 });
        }
      },
    },
  },
  websocket: {
    ...hostLinkSocket,
    message(ws, data) {
      hostLinkSocket.message(ws, data);
      if (getHost(host.id)?.status() === "online") online.resolve();
    },
  },
});
process.send?.({ url: server.url.origin, token });
