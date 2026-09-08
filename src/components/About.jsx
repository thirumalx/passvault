import React, { useState, useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';

export default function About({ onClose }) {
    const [version, setVersion] = useState('');
    const [updateStatus, setUpdateStatus] = useState('');
    const [isChecking, setIsChecking] = useState(false);

    useEffect(() => {
        getVersion().then(setVersion).catch(console.error);
    }, []);

    const checkForUpdates = async () => {
        setIsChecking(true);
        setUpdateStatus('Checking for updates...');
        try {
            const update = await check();
            if (update) {
                setUpdateStatus(`Update available: ${update.version}. Downloading...`);
                let downloaded = 0;
                let contentLength = 0;
                
                await update.downloadAndInstall((event) => {
                    switch (event.event) {
                        case 'Started':
                            contentLength = event.data.contentLength;
                            setUpdateStatus(`Started downloading ${update.version} (${contentLength} bytes)`);
                            break;
                        case 'Progress':
                            downloaded += event.data.chunkLength;
                            setUpdateStatus(`Downloading: ${Math.round((downloaded / contentLength) * 100)}%`);
                            break;
                        case 'Finished':
                            setUpdateStatus('Download finished. Installing...');
                            break;
                    }
                });

                setUpdateStatus('Update installed! Please restart the app.');
                window.alert('Update installed! Please restart the application to apply changes.');
            } else {
                setUpdateStatus('You are on the latest version.');
            }
        } catch (error) {
            console.error('Update check failed:', error);
            const errMsg = error.message || String(error);
            if (errMsg.includes('Could not fetch a valid release JSON')) {
                setUpdateStatus('Update check failed: No release published yet on GitHub.');
            } else {
                setUpdateStatus(`Failed to check for updates: ${errMsg}`);
            }
        } finally {
            setIsChecking(false);
        }
    };

    return (
        <div className="modal-overlay" style={{ zIndex: 1000 }}>
            <div className="modal-content" style={{ textAlign: 'center', maxWidth: '400px', backgroundColor: '#fff', color: '#000' }}>
                <h2>About PassVault</h2>
                <div style={{ margin: '20px 0' }}>
                    <p style={{ fontSize: '1.2em', fontWeight: 'bold' }}>PassVault</p>
                    <p>Version: {version || 'Loading...'}</p>
                    <p>A secure local password manager.</p>
                </div>
                
                <div style={{ margin: '20px 0', padding: '15px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
                    <button 
                        className="copy-button" 
                        onClick={checkForUpdates}
                        disabled={isChecking}
                        style={{ width: '100%', marginBottom: '10px' }}
                    >
                        {isChecking ? 'Checking...' : 'Check for Updates'}
                    </button>
                    {updateStatus && (
                        <p style={{ fontSize: '0.9em', color: '#555', margin: '10px 0 0 0' }}>
                            {updateStatus}
                        </p>
                    )}
                </div>

                <div className="modal-actions" style={{ justifyContent: 'center' }}>
                    <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
