import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles.css";
import { Home } from "./pages/Home.tsx";
import { RoomPage } from "./pages/RoomPage.tsx";
import { ManageSpaces } from "./pages/ManageSpaces.tsx";
import { ItemHistoryPage } from "./pages/ItemHistoryPage.tsx";
import { RecapPage } from "./pages/RecapPage.tsx";
import { DeckHistoryPage } from "./pages/DeckHistoryPage.tsx";
import { DeckEditorPage } from "./pages/DeckEditorPage.tsx";
import { ConnectAgentPage } from "./pages/ConnectAgentPage.tsx";
import { RefPage } from "./pages/RefPage.tsx";
import { AuthGate } from "./auth.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/s/:roomId" element={<RoomPage />} />
          <Route path="/r/:roomId" element={<RoomPage />} />
          <Route path="/spaces/manage" element={<ManageSpaces />} />
          <Route path="/agents" element={<ConnectAgentPage />} />
          <Route path="/ref/:kind/:id" element={<RefPage />} />
          <Route path="/items/:itemId" element={<ItemHistoryPage />} />
          <Route path="/meetings/:meetingId" element={<RecapPage />} />
          <Route path="/decks/:deckId" element={<DeckHistoryPage />} />
          <Route path="/decks/:deckId/edit" element={<DeckEditorPage />} />
        </Routes>
      </AuthGate>
    </BrowserRouter>
  </StrictMode>,
);
