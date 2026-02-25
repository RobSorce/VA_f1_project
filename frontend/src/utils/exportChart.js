import html2canvas from 'html2canvas';

/**
 * Export a DOM element as a PNG image.
 * @param {HTMLElement} element - The element to capture.
 * @param {string} [filename='chart.png'] - The download filename.
 */
export async function exportAsPng(element, filename = 'chart.png') {
  if (!element) return;
  const canvas = await html2canvas(element, {
    backgroundColor: '#0f0f1e',
    scale: 2,
    useCORS: true,
    logging: false,
  });
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
