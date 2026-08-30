import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Login from "./components/Login";
import PassVault from "./components/PassVault";
import "./App.css";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  if (!isAuthenticated) {
    return <Login onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return <PassVault />;
}

export default App;
