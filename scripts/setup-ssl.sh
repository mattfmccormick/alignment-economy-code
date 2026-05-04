#!/bin/bash
# SSL setup script for AE nodes using Let's Encrypt (certbot)
# Usage: ./setup-ssl.sh yourdomain.com admin@yourdomain.com

set -e

DOMAIN=${1:?"Usage: $0 <domain> <email>"}
EMAIL=${2:?"Usage: $0 <domain> <email>"}

echo "=== AE Node SSL Setup ==="
echo "Domain: $DOMAIN"
echo "Email:  $EMAIL"
echo ""

# Install certbot if not present
if ! command -v certbot &> /dev/null; then
  echo "Installing certbot..."
  apt-get update && apt-get install -y certbot
fi

# Get certificate (standalone mode, temporarily binds port 80)
echo "Requesting certificate from Let's Encrypt..."
certbot certonly --standalone \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  -d "$DOMAIN"

CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

echo ""
echo "=== Certificate obtained ==="
echo "Set these environment variables for your AE node:"
echo ""
echo "  AE_SSL_CERT=$CERT_DIR/fullchain.pem"
echo "  AE_SSL_KEY=$CERT_DIR/privkey.pem"
echo ""
echo "Or add to your config.json:"
echo ""
echo "  {"
echo "    \"sslCert\": \"$CERT_DIR/fullchain.pem\","
echo "    \"sslKey\": \"$CERT_DIR/privkey.pem\""
echo "  }"
echo ""
echo "Auto-renewal is configured via certbot's systemd timer."
echo "Run 'certbot renew --dry-run' to test."
