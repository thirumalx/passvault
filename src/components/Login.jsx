import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './Login.css';

export default function Login({ onLoginSuccess }) {
  const [errorMsg, setErrorMsg] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [biometryAvailable, setBiometryAvailable] = useState(false);

  useEffect(() => {
    // Check if biometric authentication is available on mount
    const checkBiometry = async () => {
      try {
        const available = await invoke('plugin:biometry|status');
        setBiometryAvailable(!!available);
      } catch (err) {
        console.error("Biometry status error:", err);
        setBiometryAvailable(false);
      }
    };
    checkBiometry();
  }, []);

  const handleLogin = async () => {
    setIsAuthenticating(true);
    setErrorMsg("");
    try {
      // Prompt native OS authentication (Windows Hello / Touch ID)
      // If authentication fails, it will throw an error and go to the catch block
      await invoke('plugin:biometry|authenticate', {
        reason: "Log in to Passvault",
        options: {
          allowDeviceCredential: true
        }
      });
      
      // If we reach here, authentication was successful
      onLoginSuccess();
    } catch (err) {
      console.error("Biometry auth error:", err);
      // Fallback or show error
      setErrorMsg(typeof err === 'string' ? err : "Biometric authentication failed or was canceled.");
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 11V15M8 11V7C8 4.79086 9.79086 3 12 3C14.2091 3 16 4.79086 16 7V11M5 11H19C20.1046 11 21 11.8954 21 13V20C21 21.1046 20.1046 22 19 22H5C3.89543 22 3 21.1046 3 20V13C3 11.8954 3.89543 11 5 11Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h2>Welcome Back</h2>
        <p className="login-subtitle">Secure access to your vault</p>
        
        {errorMsg && <div className="login-error">{errorMsg}</div>}
        
        <button 
          className="login-button" 
          onClick={handleLogin} 
          disabled={isAuthenticating}
        >
          {isAuthenticating ? "Verifying..." : "Login with OS Credentials"}
        </button>

        {!biometryAvailable && (
          <p className="login-hint">
            Note: Biometric authentication may not be configured on your system.
          </p>
        )}
      </div>
    </div>
  );
}
