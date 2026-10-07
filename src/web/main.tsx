import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles.css";
import { Home } from "./pages/Home.tsx";
import { RoomPage } from "./pages/RoomPage.tsx";
import { ItemHistoryPage } from "./pages/ItemHistoryPage.tsx";
import { RecapPage } from "./pages/RecapPage.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/r/:roomId" element={<RoomPage />} />
        <Route path="/items/:itemId" element={<ItemHistoryPage />} />
        <Route path="/meetings/:meetingId" element={<RecapPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
