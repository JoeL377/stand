// The board's top row (Views.tsx) has room after its Card and Sketch pills. Whatever shows under it can
// put its own control there, so the row is the only row: the card view puts its list of cards in it.

import { createContext } from "react";

export const BarSlot = createContext<HTMLElement | null>(null);
