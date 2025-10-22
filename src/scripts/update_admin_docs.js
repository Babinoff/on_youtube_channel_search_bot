// Sync README admin commands from router ADMIN_COMMANDS
const fs = require('fs');
const path = require('path');
const { buildAdminMarkdownList } = require('../services/admin/router');

function updateReadme() {
  const readmePath = path.join(process.cwd(), 'README.md');
  const md = fs.readFileSync(readmePath, 'utf8');

  const sectionHeader = /^##\s+Админ‑команды \(через `\/admin`\)/m; // exact header in README
  const nextHeader = /^##\s+/m; // next section header

  const headerMatch = md.match(sectionHeader);
  if (!headerMatch) {
    console.error('Не найден заголовок секции админ-команд в README.md');
    process.exitCode = 1;
    return;
  }

  const startIdx = headerMatch.index + headerMatch[0].length;

  // Find the line after the header: keep explanatory line, replace only bullet list until next header
  // We assume format: header, then optional lines (explanation), then bullets starting with "- ", until next header
  const tail = md.slice(startIdx);
  const nextHeaderMatch = tail.match(nextHeader);
  const tailEndIdx = nextHeaderMatch ? nextHeaderMatch.index : tail.length;

  const sectionBody = tail.slice(0, tailEndIdx);

  // Preserve the first non-empty lines until the first bullet; then replace bullets block
  const lines = sectionBody.split('\n');
  let firstBulletIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\-\s+`?\//.test(lines[i])) { // bullet line starting with dash and a command
      firstBulletIdx = i;
      break;
    }
  }
  if (firstBulletIdx === -1) {
    console.error('Не найден список пунктов админ-команд в README.md');
    process.exitCode = 1;
    return;
  }

  // Find end of bullets: continuous lines starting with dash, stop at first non-bullet or end
  let endBulletIdx = firstBulletIdx;
  for (let i = firstBulletIdx; i < lines.length; i++) {
    if (/^\-\s+`?\//.test(lines[i])) {
      endBulletIdx = i;
    } else {
      break;
    }
  }

  const beforeBullets = lines.slice(0, firstBulletIdx).join('\n');
  const afterBullets = lines.slice(endBulletIdx + 1).join('\n');

  const newBullets = buildAdminMarkdownList();

  const newSectionBody = [beforeBullets, newBullets, afterBullets].join('\n');
  const newMd = md.slice(0, startIdx) + newSectionBody + tail.slice(tailEndIdx);

  fs.writeFileSync(readmePath, newMd, 'utf8');
  console.log('README.md обновлен: админ-команды синхронизированы.');
}

updateReadme();