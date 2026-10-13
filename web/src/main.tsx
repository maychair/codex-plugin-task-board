import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LocalTaskBoard } from "./components/LocalTaskBoard";
import "./styles.css";

async function main() {
  let Board = LocalTaskBoard;
  if (new URLSearchParams(window.location.search).get("view") === "issues") {
    const [{ App }, { initializeTaskboardStorage }] = await Promise.all([
      import("./App"),
      import("./storage"),
    ]);
    await initializeTaskboardStorage();
    Board = App;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Board />
    </StrictMode>,
  );
}

void main();
