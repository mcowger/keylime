// Inject after the fixture's CLI-only branches. The daemon starts the session in
// a PTY and exchanges runner frames over a separate Unix socket.
export const fakeRunnerSocket = `
const rpcSocket = require("node:net").createConnection(process.env.KEYLIME_HOST_SOCKET);
rpcSocket.once("end", () => process.exit(0));
`;
