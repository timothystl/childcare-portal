document.getElementById('navToggle').addEventListener('click', function () {
  document.getElementById('navLinks').classList.toggle('open');
});

// Generate QR code for the portal
const qrPortalUrl = 'https://mdo.timothystl.org/calendar'; // Replace with actual portal URL
if (document.getElementById('siteQrCode')) {
  new QRCode(document.getElementById('siteQrCode'), {
    text: qrPortalUrl,
    width: 120,
    height: 120,
    colorDark: '#1c3160',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
}
