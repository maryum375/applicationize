var fs = require('fs');
var url = require('url');
var pem = require('pem');
var https = require('https');
var join = require('path').join;
var cheerio = require('cheerio');
var request = require('request');
var thunkify = require('thunkify');

// CRX packaging module, instantiated with the `new` keyword
var Extension = require('crx');

// POST /generate
module.exports = function *() {
    // Get target URL from input
    var url = this.request.body.url;

    // Build .crx config for the provided URL
    var crxConfig = yield exports.buildCrxConfig(url);

    // Generate the .crx file based on the config
    var crxBuffer = yield exports.generateCrx(crxConfig);

    // Send it to the browser (save to disk)
    yield exports.sendCrx(this, crxConfig, crxBuffer);
};

exports.buildCrxConfig = function *(targetUrl) {

    var parsedUrl = exports.parseUrl(targetUrl);

    // Prepare crx object with default values
    var crxConfig = {
        url: targetUrl,
        parsedUrl: parsedUrl,
        title: parsedUrl.hostname,
        filename: parsedUrl.hostname + '.crx'
    };

    // Normalize hostname for custom use-cases
    crxConfig.host = parsedUrl.hostname.toLowerCase().replace('www.', '');

    var dom;

    // Execute GET request to provided URL
    // May fail for internal URLs, continue anyway
    try {
        dom = yield exports.getPageDOM(crxConfig.url);
    }
    catch (exc) {
        return crxConfig;
    }

    // Extract .crx icon from page's shortcut-icon <link> element
    crxConfig.icon = dom('link[rel="icon"], link[rel="shortcut icon"]').attr('href');

    crxConfig.title = exports.getCrxTitle(dom, crxConfig);
};

exports.getCrxTitle = function (dom, crxConfig) {

    // Extract extension title from the dom's <title> tag
    var title = dom('title').text().trim() || crxConfig.parsedUrl.hostname;

    // Handle custom use-cases per hostname
    switch (crxConfig.host) {
        case 'messenger.com':
            // Fix weird 0x8234 chars in FB messenger <title>
            title = 'Messenger';
            break;
    }
    return title;
};


exports.parseUrl = function (targetUrl) {
    // Bad input?
    if (!targetUrl) {
        throw new Error('Please provide a URL to continue.');
    }

    // Parse URL (to retrieve hostname and verify its validity)
    var parsedUrl = url.parse(targetUrl);

    // Parse failed?
    if (!parsedUrl || !parsedUrl.protocol || parsedUrl.protocol.indexOf('http') == -1) {
        throw new Error('Please provide a valid URL for your extension. (It must start with http(s)://)');
    }

    return parsedUrl;
};

exports.getPageDOM = function* (url) {

    // Prepare request (send fake browser user-agent header)
    var req = {
        url: url,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36'
        }
    };

    var response = yield thunkify(request)(req);

    // Load DOM into Cheerio (HTML parser)
    return cheerio.load(response[0].body);
};

exports.generateCrx = function* (crxConfig) {
    // Generate pem certificate
    var cert = yield thunkify(pem.createCertificate)({days: 365 * 10, selfSigned: true});

    // Init new .crx extension with our private key
    var crx = new Extension({privateKey: cert.clientKey});

    // Load extension manifest and default icon
    yield crx.load(join(__dirname, "../lib/extension/files"));

    // Set extension title to extension URL's <title>
    crx.manifest.name = crxConfig.title;

    // Ask for permission to access the specified URL
    crx.manifest.app.urls.push(crxConfig.url);

    // Configure the launch behavior of the extension to the specfied URL
    crx.manifest.app.launch.web_url = crxConfig.url;

    // Override extension icon if we prepared one for this host
    yield exports.overrideIconIfExists(crxConfig, crx);

    // Only continue if we haven't overriden the icon
    if (!crxConfig.iconOverriden) {
        // Got a favicon from the host's HTML?
        if (crxConfig.icon) {
            // Download it and overwrite default icon
            yield exports.downloadIcon(crxConfig, crx);
        }
        else {
            // Set a placeholder icon instead (letter)
            yield exports.setPlaceholderIcon(crxConfig, crx);
        }
    }

    // Pack the extension into a .crx and return its buffer
    var crxBuffer = yield crx.pack();

    // Return buffer
    return crxBuffer;
};

exports.downloadIcon = function*(crxConfig, crx) {
    // Convert relative icon path to absolute
    var absoluteIconUrl = url.resolve(crxConfig.url, crxConfig.icon);

    // Resolve succeeded?
    if (absoluteIconUrl) {
        // Set download path as current extension icon's path
        var downloadPath = crx.path + "/" + crx.manifest.icons['128'];

        // Download it
        yield exports.downloadFile(absoluteIconUrl, downloadPath);
    }
};

exports.overrideIconIfExists = function*(crxConfig, crx) {
    // Build path to override icon
    var iconPath = join(__dirname, '../assets/icons/' + crxConfig.host + '.png');

    try {
        // Check if icon exists
        fs.accessSync(iconPath, fs.F_OK);
    }
    catch (e) {
        // No such file
        return;
    }

    // Set target copy path as current extension icon's path
    var copyToPath = crx.path + "/" + crx.manifest.icons['128'];

    // Copy the local file and override extension's default icon
    yield exports.copyLocalFile(iconPath, copyToPath);

    // Avoid downloading the original favicon or setting a placeholder one
    crxConfig.iconOverriden = true;
};

exports.setPlaceholderIcon = function*(crxConfig, crx) {
    // Grab first char (hopefully a letter)
    var letter = crxConfig.parsedUrl.hostname.substring(0, 1).toUpperCase();

    // Not an English letter?
    if (!letter.match(/[A-Z]/)) {
        return;
    }

    // Build path to placeholder letter icon
    var copyFromPath = join(__dirname, '../lib/extension/icons/fallback/' + letter + '.png');

    // Set target copy path as current extension icon's path
    var copyToPath = crx.path + "/" + crx.manifest.icons['128'];

    // Copy the local file and override extension's default icon
    yield exports.copyLocalFile(copyFromPath, copyToPath);
};

exports.sendCrx = function*(request, crxConfig, crxBuffer) {
    // Set content-type to .crx extension mime type
    request.set('content-type', 'application/x-chrome-extension');

    // Set extension filename
    request.set('content-disposition', 'attachment; filename=' + crxConfig.filename);

    // Set the request body to the .crx file buffer
    request.body = crxBuffer;
};

exports.downloadFile = function (url, filePath) {
    // Promisify the request
    return new Promise(function (resolve, reject) {
        try {
            // Create write stream
            var stream = fs.createWriteStream(filePath);

            // Wait for finish event
            stream.on('finish', function () {
                // Resolve the promise
                return resolve(true);
            });

            // Pipe the request to a file
            return request(url).pipe(stream);
        } catch (e) {
            // Failed
            return reject(e);
        }
    });
};

exports.copyLocalFile = function (from, to) {
    // Promisify the request
    return new Promise(function (resolve, reject) {
        try {
            // Create write stream
            var writeStream = fs.createWriteStream(to);

            // Wait for finish event
            writeStream.on('finish', function () {
                // Resolve the promise
                return resolve(true);
            });

            // Pipe the "from" stream into the "to" stream
            fs.createReadStream(from).pipe(writeStream);
        } catch (e) {
            // Failed
            return reject(e);
        }
    });
};