import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom";
import "./styles.css";
import { Home } from "./pages/Home.tsx";
import { BrainstormPage, ConnectAgentPage, DeckEditorPage, DeckHistoryPage, DesignReviewPage, ItemHistoryPage, ManageSpaces, RecapPage, ReviewPage, loadTheRest } from "./later.tsx";
import { RoomPage } from "./pages/RoomPage.tsx";
import { RefPage } from "./pages/RefPage.tsx";
import { AuthGate, useAuth } from "./auth.tsx";
import { MentionScope, useSpacePeople } from "./Mentions.tsx";
import { Toasts } from "./Toasts.tsx";
import { RouteMotion } from "./motion.ts";

/** A page in a space: @Names of the people in it are marked in what it shows. */
function InSpace({ children }: { children: React.ReactNode }) {
  const { roomId } = useParams();
  const { user } = useAuth();
  const people = useSpacePeople(roomId);
  return (
    <MentionScope people={people} me={user.id}>
      {children}
    </MentionScope>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/s/:roomId" element={<InSpace><RoomPage /></InSpace>} />
          <Route path="/r/:roomId" element={<InSpace><RoomPage /></InSpace>} />
          <Route path="/s/:roomId/review/:reviewId" element={<InSpace><ReviewPage /></InSpace>} />
          <Route path="/s/:roomId/design-review" element={<InSpace><DesignReviewPage /></InSpace>} />
          <Route path="/s/:roomId/design-review/:reviewId" element={<InSpace><DesignReviewPage /></InSpace>} />
          <Route path="/s/:roomId/brainstorm/:brainstormId" element={<InSpace><BrainstormPage /></InSpace>} />
          <Route path="/spaces/manage" element={<ManageSpaces />} />
          <Route path="/agents" element={<ConnectAgentPage />} />
          <Route path="/ref/:kind/:id" element={<RefPage />} />
          <Route path="/items/:itemId" element={<ItemHistoryPage />} />
          <Route path="/meetings/:meetingId" element={<RecapPage />} />
          <Route path="/decks/:deckId" element={<DeckHistoryPage />} />
          <Route path="/decks/:deckId/edit" element={<DeckEditorPage />} />
        </Routes>
        <RouteMotion />
      </AuthGate>
      <Toasts />
    </BrowserRouter>
  </StrictMode>,
);

loadTheRest();
