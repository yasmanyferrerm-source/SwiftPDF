// Runs after `npx cap add android`. Lets Android open PDFs from other apps
// ("Open with SwiftPDF") and stamps the version from package.json.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');

let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('application/pdf')) {
  const filters = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="file" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
`;
  manifest = manifest.replace(/(\n\s*<\/activity>)/, `${filters}$1`);
  fs.writeFileSync(manifestPath, manifest);
  console.log('AndroidManifest: added PDF intent filters');
}

// App icon (adaptive + legacy + themed) and splash screen
const resSrc = path.join(root, 'resources', 'android', 'res');
if (fs.existsSync(resSrc)) {
  fs.cpSync(resSrc, path.join(root, 'android', 'app', 'src', 'main', 'res'), { recursive: true, force: true });
  console.log('Android icons and splash screens copied');
}

const versionCode = parseInt(process.env.VERSION_CODE || '1', 10);
let gradle = fs.readFileSync(gradlePath, 'utf8');
gradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
fs.writeFileSync(gradlePath, gradle);
console.log(`build.gradle: versionCode ${versionCode}, versionName ${pkg.version}`);
