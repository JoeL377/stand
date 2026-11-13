// The link to a brainstorm or design session's page. On its own so the pages that only link to one
// don't load the board with it.
export const brainstormHref = (roomId: string, id: string) => `/s/${roomId}/brainstorm/${id}`;
