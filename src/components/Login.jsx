import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './Login.css';

export default function Login({ onLoginSuccess }) {
  const [errorMsg, setErrorMsg] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [biometryAvailable, setBiometryAvailable] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [isRestoringKey, setIsRestoringKey] = useState(false);

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
      setErrorMsg(typeof err === 'string' ? err : "Biometric authentication failed or was canceled.");
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleRestoreWithKey = async (e) => {
    e.preventDefault();
    if (!recoveryInput.trim()) return;
    setIsRestoringKey(true);
    setRecoveryError("");
    try {
      const cleanKey = await invoke("normalize_recovery_key", { input: recoveryInput.trim() });
      await invoke("set_vault_key", { key: cleanKey });
      setShowRecoveryModal(false);
      onLoginSuccess();
    } catch (err) {
      console.error("Failed to restore with recovery key:", err);
      setRecoveryError(typeof err === 'string' ? err : "Invalid recovery key format (expected 64 hex characters or PV-XXXX code).");
    } finally {
      setIsRestoringKey(false);
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

        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #eaeaea' }}>
          <button
            type="button"
            className="login-recovery-link"
            onClick={() => {
              setRecoveryInput("");
              setRecoveryError("");
              setShowRecoveryModal(true);
            }}
          >
            🔑 Restore Vault with Recovery Key
          </button>
        </div>
      </div>

      {showRecoveryModal && (
        <div className="modal-overlay" style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000
        }}>
          <div className="modal-content" style={{
            background: 'white',
            padding: '28px',
            borderRadius: '12px',
            maxWidth: '480px',
            width: '90%',
            color: '#333',
            textAlign: 'left',
            boxShadow: '0 10px 30px rgba(0,0,0,0.2)'
          }}>
            <h3 style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '8px', color: '#111' }}>
              <span>🔑</span> Restore with Recovery Key
            </h3>
            <p style={{ fontSize: '0.88rem', color: '#666', lineHeight: '1.4', margin: '0 0 16px' }}>
              Moving to a new PC or recovered from an OS reinstall? Enter your <strong>Emergency Recovery Key</strong> to save it into your local OS Credential Manager and unlock your vault.
            </p>

            <form onSubmit={handleRestoreWithKey}>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px', color: '#333' }}>
                  Emergency Recovery Key
                </label>
                <textarea
                  required
                  rows="3"
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '6px',
                    border: '1px solid #ccc',
                    fontFamily: 'monospace',
                    fontSize: '0.88rem',
                    boxSizing: 'border-box',
                    resize: 'vertical'
                  }}
                  placeholder="Paste PV-XXXX-... or 64-character hex key"
                  value={recoveryInput}
                  onChange={e => setRecoveryInput(e.target.value)}
                  autoFocus
                />
              </div>

              {recoveryError && (
                <div style={{
                  color: '#dc2626',
                  background: '#fef2f2',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '0.85rem',
                  marginBottom: '16px'
                }}>
                  {recoveryError}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  style={{
                    background: 'transparent',
                    border: '1px solid #ccc',
                    borderRadius: '6px',
                    padding: '8px 16px',
                    cursor: 'pointer'
                  }}
                  onClick={() => setShowRecoveryModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="login-button"
                  style={{ width: 'auto', padding: '8px 20px' }}
                  disabled={isRestoringKey}
                >
                  {isRestoringKey ? "Verifying..." : "Restore Key & Login"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
