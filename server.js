const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const puppeteer = require('puppeteer');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const Afip = require('@afipsdk/afip.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Directorio para guardar adjuntos físicamente
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Directorio de certificados AFIP
const certsDir = path.join(__dirname, 'afip_certs');
if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
}

const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadMemoria = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});
const uploadDisco = multer({ 
    storage: diskStorage,
    limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// =========================================================================
// INICIALIZACIÓN DE SDK AFIP / ARCA (WEB SERVICE OFICIAL WS_CPE / WSCTG)
// =========================================================================
let afip = null;
const certPath = path.join(certsDir, 'cert.crt');
const keyPath = path.join(certsDir, 'cert.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
        afip = new Afip({ 
            CUIT: 30123456789, // Reemplazar por CUIT de EDP Agroindustrial S.A.
            cert: certPath,
            key: keyPath,
            production: true 
        });
        console.log("✅ SDK de AFIP/ARCA inicializado correctamente con certificado digital.");
    } catch (e) {
        console.error("Error al inicializar SDK de AFIP:", e.message);
        afip = null;
    }
} else {
    console.warn("⚠️ Advertencia: No se encontraron 'cert.crt' o 'cert.key' en la carpeta afip_certs/.");
}

// =========================================================================
// INICIALIZACIÓN Y GESTIÓN DE BOT DE WHATSAPP AUTOMÁTICO
// =========================================================================
let isWaReady = false;
let currentWaNumber = null;
let currentQrDataUrl = null;

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

const waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        executablePath: CHROMIUM_PATH,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--single-process',
            '--remote-debugging-port=0'
        ]
    }
});

waClient.on('qr', async (qr) => {
    console.log('\n======================================================');
    console.log('CÓDIGO QR DE WHATSAPP GENERADO (DISPONIBLE EN DASHBOARD)');
    console.log('======================================================\n');
    qrcodeTerminal.generate(qr, { small: true });

    try {
        currentQrDataUrl = await QRCode.toDataURL(qr);
        isWaReady = false;
        currentWaNumber = null;
        io.emit('wa_status', { ready: false, qr: currentQrDataUrl, number: null });
    } catch (err) {
        console.error("Error al generar DataURL del QR:", err);
    }
});

waClient.on('ready', () => {
    isWaReady = true;
    currentQrDataUrl = null;
    currentWaNumber = waClient.info && waClient.info.wid ? waClient.info.wid.user : 'Conectado';
    console.log(`✅ Bot de WhatsApp conectado (+${currentWaNumber}).`);
    io.emit('wa_status', { ready: true, qr: null, number: currentWaNumber });
});

waClient.on('authenticated', () => {
    console.log('Autenticación de WhatsApp exitosa.');
});

waClient.on('auth_failure', msg => {
    console.error('Error de autenticación en WhatsApp:', msg);
    isWaReady = false;
    currentWaNumber = null;
    io.emit('wa_status', { ready: false, qr: null, number: null, error: 'Error de autenticación' });
});

waClient.on('disconnected', (reason) => {
    console.log('WhatsApp desconectado:', reason);
    isWaReady = false;
    currentWaNumber = null;
    currentQrDataUrl = null;
    io.emit('wa_status', { ready: false, qr: null, number: null });
    try { waClient.initialize(); } catch (e) {}
});

waClient.initialize();

async function enviarWhatsAppAutomatico(telefono, mensaje) {
    if (!isWaReady) {
        console.warn("WhatsApp aún no está listo. El mensaje no se pudo enviar automáticamente.");
        return false;
    }

    try {
        let num = String(telefono).replace(/\D/g, '');
        if (!num.startsWith('549')) {
            if (num.startsWith('54')) {
                num = '549' + num.slice(2);
            } else {
                num = '549' + num;
            }
        }
        
        const chatId = `${num}@c.us`;
        await waClient.sendMessage(chatId, mensaje);
        console.log(`[WHATSAPP ENVIADO AUTOMÁTICAMENTE] A: ${chatId}`);
        return true;
    } catch (err) {
        console.error("Error al enviar mensaje por WhatsApp:", err.message);
        return false;
    }
}

app.get('/api/wa-status', (req, res) => {
    res.json({
        ready: isWaReady,
        qr: currentQrDataUrl,
        number: currentWaNumber
    });
});

app.post('/api/wa-logout', async (req, res) => {
    try {
        isWaReady = false;
        currentWaNumber = null;
        currentQrDataUrl = null;
        io.emit('wa_status', { ready: false, qr: null, number: null });

        try {
            await waClient.logout();
        } catch (e) {
            await waClient.destroy();
        }

        setTimeout(() => {
            waClient.initialize();
        }, 1000);

        return res.json({ success: true, message: 'Sesión de WhatsApp reiniciada.' });
    } catch (err) {
        console.error("Error al desvincular WhatsApp:", err.message);
        try { waClient.initialize(); } catch (e) {}
        return res.json({ success: true, message: 'Reiniciando cliente de WhatsApp...' });
    }
});

// =========================================================================
// 1. RUTAS EXPLÍCITAS DE NAVEGACIÓN
// =========================================================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// =========================================================================
// 2. PERSISTENCIA DE DATOS
// =========================================================================
const DATA_FILE = path.join(__dirname, 'turnos.json');
let turnos = [];

if (fs.existsSync(DATA_FILE)) {
    try {
        turnos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error("Error al cargar turnos.json:", e.message);
        turnos = [];
    }
}

function guardarTurnos() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(turnos, null, 2));
}

// =========================================================================
// 3. FUNCIONES DE PROCESAMIENTO LOCAL (PDF & OCR)
// =========================================================================

function extraerTextoPdfNativo(buffer) {
    let textoCompleto = buffer.toString('latin1');
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;

    while ((match = streamRegex.exec(buffer.toString('latin1'))) !== null) {
        try {
            const streamBuffer = Buffer.from(match[1], 'latin1');
            const decompressed = zlib.inflateSync(streamBuffer).toString('latin1');
            const partesTexto = decompressed.match(/\((.*?)\)/g);
            if (partesTexto) {
                textoCompleto += '\n' + partesTexto.map(t => t.replace(/[()]/g, '')).join(' ');
            }
            textoCompleto += '\n' + decompressed;
        } catch (e) {}
    }
    return textoCompleto;
}

async function extraerTextoImagenOCR(buffer) {
    try {
        const bufferOptimizado = await sharp(buffer)
            .resize({ width: 1600, fit: 'inside', withoutEnlargement: true })
            .grayscale()
            .normalize()
            .toBuffer();

        const worker = await createWorker('spa');
        const ret = await worker.recognize(bufferOptimizado);
        await worker.terminate();
        return ret.data.text;
    } catch (e) {
        console.error("Error optimizando o procesando imagen con OCR:", e.message);
        return "";
    }
}

app.post('/api/procesar-archivo', uploadMemoria.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });

        let textoExtraido = '';
        const mimeType = req.file.mimetype;
        const nombreArchivo = req.file.originalname.toLowerCase();

        if (mimeType === 'application/pdf' || nombreArchivo.endsWith('.pdf')) {
            textoExtraido = extraerTextoPdfNativo(req.file.buffer);
        } else {
            textoExtraido = await extraerTextoImagenOCR(req.file.buffer);
        }

        let ctg = '';
        let chasis = '';
        let acoplado = '';
        let chofer = '';
        let producto = '';

        const matchCTG = textoExtraido.match(/CTG:?\s*(\d{10,12})/i) || textoExtraido.match(/\b(10\d{9,10})\b/);
        if (matchCTG) ctg = matchCTG[1] || matchCTG[0];

        const patronPatente = /\b([A-Z]{2}\s?\d{3}\s?[A-Z]{2}|[A-Z]{3}\s?\d{3})\b/gi;
        const patentesEncontradas = textoExtraido.match(patronPatente);

        if (patentesEncontradas && patentesEncontradas.length > 0) {
            const patentesLimpias = [...new Set(patentesEncontradas.map(p => p.replace(/\s+/g, '').toUpperCase()))];
            chasis = patentesLimpias[0] || '';
            if (patentesLimpias.length > 1) acoplado = patentesLimpias[1] || '';
        }

        let matchChofer = textoExtraido.match(/Chofer\s*:?\s*(?:\d{11}|\d{2}-\d{8}-\d{1})?\s*[-:\s]*([A-ZÁÉÍÓÚÑ\s]{5,40})/i);
        if (matchChofer && matchChofer[1]) chofer = matchChofer[1].trim();

        if (!chofer || chofer.length < 4) {
            const matchCuitChofer = textoExtraido.match(/(?:20|23|24|27)[-]?\d{8}[-]?\d\s*[-:\s]+\s*([A-ZÁÉÍÓÚÑ]{2,20}(?:\s+[A-ZÁÉÍÓÚÑ]{2,20}){1,3})/i);
            if (matchCuitChofer && matchCuitChofer[1]) chofer = matchCuitChofer[1].trim();
        }

        if (chofer) {
            chofer = chofer.replace(/\b(INTERMEDIARIO|FLETE|PAGADOR|TRANSPORTISTA|CARTA DE PORTE|DOMINIO|DECLARACION|JURADA|SECCION)\b/gi, '').replace(/\s+/g, ' ').trim();
        }

        const matchProducto = textoExtraido.match(/(SOJA|GIRASOL|MAIZ|MAÍZ|TRIGO|CEBADA|SORGO)/i);
        if (matchProducto) {
            let prodRaw = matchProducto[1].toUpperCase();
            if (prodRaw.includes('MAI') || prodRaw.includes('MAÍ')) producto = 'MAIZ';
            else producto = prodRaw;
        }

        const halloAlgo = ctg || chasis || chofer || producto;
        return res.json({ success: halloAlgo ? true : false, datos: { ctg, chasis, acoplado, chofer, producto } });

    } catch (error) {
        console.error("Error al procesar el archivo:", error.message);
        return res.json({ success: false, message: 'No se pudieron extraer datos del archivo.' });
    }
});

// =========================================================================
// 4. ENDPOINT CONSULTA SDK AFIP / ARCA (WEB SERVICE WS_CPE / WSCTG)
// =========================================================================

app.post('/api/consultar-cpe', async (req, res) => {
    let { ctg } = req.body;
    if (!ctg) return res.status(400).json({ success: false, message: 'Ingrese un número de CTG o CPE' });

    const matchSoloNumeros = String(ctg).match(/\b(10\d{9,10}|\d{10,12})\b/);
    if (matchSoloNumeros) ctg = matchSoloNumeros[0];
    else ctg = String(ctg).replace(/\D/g, '');

    if (afip && afip.options) {
        try {
            console.log(`[AFIP SDK] Consultando Web Service WS_CPE para CTG: ${ctg}...`);

            const wsCpe = afip.WebService('ws_cpe');
            const respuestaAfip = await wsCpe.executeRequest('consultarCpe', {
                cpe: {
                    nroCpe: Number(ctg)
                }
            });

            console.log("[AFIP SDK] Respuesta recibida:", JSON.stringify(respuestaAfip));

            if (respuestaAfip) {
                const chasis = respuestaAfip.dominioChasis || respuestaAfip.chasis || respuestaAfip.patente || '';
                const acoplado = respuestaAfip.dominioAcoplado || respuestaAfip.acoplado || '';
                const chofer = respuestaAfip.nombreChofer || respuestaAfip.chofer || respuestaAfip.conductor || '';

                return res.json({
                    success: (chasis || chofer) ? true : false,
                    datos: { ctg, chasis, acoplado, chofer }
                });
            }
        } catch (errAfip) {
            console.error("Detalle de error AFIP SDK:", errAfip.message || errAfip);
            return res.json({ 
                success: false, 
                message: `Respuesta ARCA: ${errAfip.message || 'No se obtuvo información para esta CPE/CTG.'}` 
            });
        }
    }

    return res.json({ 
        success: false, 
        message: 'El servicio de AFIP no está activo o faltan los certificados digitales en afip_certs/.' 
    });
});

app.get('/api/turnos', (req, res) => res.json(turnos));

// =========================================================================
// 5. REGISTRO Y GESTIÓN DE TURNOS
// =========================================================================

app.post('/api/turnos', uploadDisco.single('adjunto'), (req, res) => {
    try {
        const {
            tipo_operacion,
            tipo_documento,
            dominio_chasis,
            dominio_acoplado,
            chofer_nombre,
            chofer_telefono,
            detalles_doc,
            producto_carga
        } = req.body;

        const nuevoId = turnos.length > 0 ? Math.max(...turnos.map(t => t.id)) + 1 : 1;
        const numTurno = String(nuevoId).padStart(3, '0');
        const codigoTurno = `T-${numTurno}`;
        const ahuraIso = new Date().toISOString();

        const nuevoTurno = {
            id: nuevoId,
            codigo_turno: codigoTurno,
            tipo_operacion: tipo_operacion || 'DESCARGA',
            tipo_documento: tipo_documento || 'CARTA_DE_PORTE',
            producto_carga: producto_carga || 'GRANO / INSUMO',
            dominio_chasis: (dominio_chasis || '').toUpperCase(),
            dominio_acoplado: (dominio_acoplado || '').toUpperCase(),
            chofer_nombre: chofer_nombre || '',
            chofer_telefono: chofer_telefono || '',
            detalles_doc: detalles_doc || '',
            adjunto_path: req.file ? `/uploads/${req.file.filename}` : null,
            estado: 'ESPERANDO',
            
            fecha_ingreso_playa: ahuraIso,
            fecha_llamado_balanza: null,
            fecha_ingreso_balanza: null,
            fecha_salida_balanza: null,
            reencolado_cant: 0
        };

        // Guardar siempre en memoria y archivo JSON
        turnos.push(nuevoTurno);
        guardarTurnos();

        // Notificar inmediatamente al Dashboard por Socket.io
        io.emit('nuevo_turno', nuevoTurno);

        // Enviar mensaje de bienvenida en segundo plano
        if (chofer_telefono) {
            const msjBienvenida = `✅ *TURNO REGISTRADO EN PLAYA*\n\n` +
                `*Turno:* ${codigoTurno}\n` +
                `*Dominio:* ${nuevoTurno.dominio_chasis}\n` +
                `*Operación:* ${nuevoTurno.tipo_operacion}\n` +
                `*Documento:* ${nuevoTurno.tipo_documento}\n\n` +
                `Su solicitud ingresó a la lista de espera. Le enviaremos un mensaje por este medio cuando deba avanzar a Balanza.`;
            
            enviarWhatsAppAutomatico(chofer_telefono, msjBienvenida).catch(e => {
                console.warn("No se pudo enviar WhatsApp, pero el turno fue registrado correctamente.");
            });
        }

        return res.json({ success: true, turno: nuevoTurno });
    } catch (err) {
        console.error("Error al registrar turno:", err);
        return res.status(500).json({ success: false, message: 'Error al registrar turno' });
    }
});

app.post('/api/turnos/estado', async (req, res) => {
    const { id, estado } = req.body;
    const turno = turnos.find(t => t.id === parseInt(id));

    if (turno) {
        const timestamp = new Date().toISOString();

        if (estado === 'EN_TRANSITO') {
            turno.estado = 'EN_TRANSITO';
            turno.fecha_llamado_balanza = timestamp;
            
            if (turno.chofer_telefono) {
                const mensaje = `🚛 *LLAMADO A BALANZA*\n\n` +
                    `Hola ${turno.chofer_nombre || ''}! Su turno *${turno.codigo_turno}* (Patente *${turno.dominio_chasis}*) ha sido llamado a BALANZA.\n\n` +
                    `Por favor ingrese al sector de pesaje.`;
                enviarWhatsAppAutomatico(turno.chofer_telefono, mensaje).catch(e => {});
            }
        } else if (estado === 'EN_BALANZA') {
            turno.estado = 'EN_BALANZA';
            turno.fecha_ingreso_balanza = timestamp;
        } else if (estado === 'FINALIZADO') {
            turno.estado = 'FINALIZADO';
            turno.fecha_salida_balanza = timestamp;

            // MENSAJE AUTOMÁTICO DE CIERRE DE PESAJE
            if (turno.chofer_telefono) {
                const msjFinalizado = `⚖️ *PESAJE FINALIZADO - EDP AGROINDUSTRIAL*\n\n` +
                    `Hola *${turno.chofer_nombre || 'Chofer'}*, el pesaje de su camión (Patente *${turno.dominio_chasis}*) para el turno *${turno.codigo_turno}* ha sido registrado con éxito.\n\n` +
                    `¡Muchas gracias y buen viaje! Si realiza otro viaje hoy, recuerde registrar el nuevo turno al ingresar a playa.`;

                enviarWhatsAppAutomatico(turno.chofer_telefono, msjFinalizado).catch(e => {
                    console.warn("No se pudo enviar WhatsApp de finalización.");
                });
            }
        } else if (estado === 'RE_ENCOLADO') {
            turno.estado = 'ESPERANDO';
            turno.reencolado_cant = (turno.reencolado_cant || 0) + 1;
            
            if (turno.chofer_telefono) {
                const mensaje = `⚠️ *TURNO RE-ENCOLADO*\n\n` +
                    `Hola! Debido a que no se presentó a tiempo en Balanza para su turno *${turno.codigo_turno}* (${turno.dominio_chasis}), su solicitud ha vuelto a la lista de espera.\n\n` +
                    `Aguarde en playa a ser llamado nuevamente.`;
                enviarWhatsAppAutomatico(turno.chofer_telefono, mensaje).catch(e => {});
            }
        }

        guardarTurnos();
        io.emit('cambio_estado', { id: turno.id, estado: turno.estado, timestamp });
        return res.json({ success: true, turno });
    }

    return res.status(404).json({ success: false, message: 'Turno no encontrado' });
});

io.on('connection', (socket) => {
    console.log('Cliente Socket.io conectado:', socket.id);
    socket.emit('wa_status', { ready: isWaReady, qr: currentQrDataUrl, number: currentWaNumber });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor TurnoBalanza activo en http://0.0.0.0:${PORT}`);
});