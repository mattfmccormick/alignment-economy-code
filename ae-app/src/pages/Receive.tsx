import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { loadWallet } from '../lib/keys';

export function Receive() {
  const wallet = loadWallet();
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!wallet?.accountId) return;
    QRCode.toDataURL(wallet.accountId, { width: 240, margin: 1 })
      .then(setQr)
      .catch(() => {});
  }, [wallet?.accountId]);

  if (!wallet?.accountId) return null;

  function copyId() {
    navigator.clipboard.writeText(wallet!.accountId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-4 space-y-5">
      <h2 className="text-xl font-serif text-white">Receive Points</h2>
      <p className="text-sm text-gray-400">
        Have someone scan this code, or share your Account ID, to send you points.
      </p>

      <div className="flex flex-col items-center gap-4 bg-navy border border-navy-light rounded-2xl p-6">
        {qr ? (
          <img src={qr} alt="Your account QR code" className="w-56 h-56 rounded-xl bg-white p-2" />
        ) : (
          <div className="w-56 h-56 rounded-xl bg-navy-light animate-pulse" />
        )}
        <div className="w-full text-center">
          <p className="text-xs text-gray-500 mb-1">Your Account ID</p>
          <p className="text-sm text-white font-mono break-all">{wallet.accountId}</p>
        </div>
        <button
          onClick={copyId}
          className="w-full py-3 bg-teal text-white rounded-xl text-sm font-medium hover:bg-teal-dark transition-colors"
        >
          {copied ? 'Copied!' : 'Copy Account ID'}
        </button>
      </div>
    </div>
  );
}
