// Generate QR code pointing to the portal URL
const portalUrl = document.getElementById('portalUrl').textContent.trim();
new QRCode(document.getElementById('posterQrCode'), {
  text: portalUrl,
  width: 140,
  height: 140,
  colorDark: '#1c3160',
  colorLight: '#ffffff',
  correctLevel: QRCode.CorrectLevel.M
});
