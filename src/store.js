const fs = require('fs');
const path = require('path');

// Простое хранилище: один JSON-файл, запись через временный файл,
// чтобы при падении процесса не остался обрезанный JSON.
class JsonStore {
  constructor(file, fallback) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = fallback;
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
