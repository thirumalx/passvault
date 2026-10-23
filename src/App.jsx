import { useState } from "react";
import Login from "./components/Login";
import PassVault from "./components/PassVault";
import { I18nProvider } from "./i18n";
import "./App.css";

function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  if (!isAuthenticated) {
    return <Login onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return <PassVault />;
}

function App() {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
}

export default App;
