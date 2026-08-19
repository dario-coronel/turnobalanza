const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const puppeteer = require('puppeteer');
const { createWorker } = require('tesseract.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Directorio para guardar adjuntos físicamente
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadMemoria = multer({ storage: multer.memoryStorage() });
const uploadDisco = multer({ storage: diskStorage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================================================================
// 1. RUTAS ESPECÍFICAS DE PÁGINAS (Deben ir ANTES de express.static)
// =========================================================================
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/balanza', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// =========================================================================
// 2. ARCHIVOS ESTÁTICOS (Sirve index.html para la raíz /)
// =========================================================================
app.use(express.static(path.join(__dirname, 'public')));

// Persistencia en JSON
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

// Función para extraer texto de PDF
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

// Función para procesar imágenes con Tesseract OCR
async function extraerTextoImagenOCR(buffer) {
    try {
        const worker = await createWorker('spa');
        const ret = await worker.recognize(buffer);
        await worker.terminate();
        return ret.data.text;
    } catch (e) {
        console.error("Error en Tesseract OCR:", e.message);
        return "";
    }
}

// =========================================================================
// 3. ENDPOINTS DE LA API
// =========================================================================

// Endpoint para procesar archivo (PDF o Foto)
app.post('/api/procesar-archivo', uploadMemoria.single('archivo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
        }

        let textoExtraido = '';
        const mimeType = req.file.mimetype;
        const nombreArchivo = req.file.originalname.toLowerCase();

        if (mimeType === 'application/pdf' || nombreArchivo.endsWith('.pdf')) {
            textoExtraido = extraerTextoPdfNativo(req.file.buffer);
        } else {
            console.log("Procesando foto con OCR...");
            textoExtraido = await extraerTextoImagenOCR(req.file.buffer);
        }

        let ctg = '';
        let chasis = '';
        let acoplado = '';
        let chofer = '';

        // Extraer CTG / CPE
        const matchCTG = textoExtraido.match(/CTG:?\s*(\d{10,12})/i) || textoExtraido.match(/\b(10\d{9,10})\b/);
        if (matchCTG) {
            ctg = matchCTG[1] || matchCTG[0];
        }

        // Extraer Dominios
        const patronPatente = /\b([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3})\b/gi;
        const patentesEncontradas = textoExtraido.match(patronPatente);

        if (patentesEncontradas && patentesEncontradas.length > 0) {
            const patentesLimpias = [...new Set(patentesEncontradas.map(p => p.toUpperCase()))];
            chasis = patentesLimpias[0] || '';
            if (patentesLimpias.length > 1) acoplado = patentesLimpias[1] || '';
        }

        // Extraer Chofer
        let matchChofer = textoExtraido.match(/Chofer\s*:?\s*(?:\d{11}|\d{2}-\d{8}-\d{1})?\s*[-:\s]*([A-ZÁÉÍÓÚÑ\s]{5,40})/i);
        if (matchChofer && matchChofer[1]) chofer = matchChofer[1].trim();

        if (!chofer || chofer.length < 4) {
            const matchCuitChofer = textoExtraido.match(/(?:20|23|24|27)[-]?\d{8}[-]?\d\s*[-:\s]+\s*([A-ZÁÉÍÓÚÑ]{2,20}(?:\s+[A-ZÁÉÍÓÚÑ]{2,20}){1,3})/i);
            if (matchCuitChofer && matchCuitChofer[1]) chofer = matchCuitChofer[1].trim();
        }

        if (chofer) {
            chofer = chofer.replace(/\b(INTERMEDIARIO|FLETE|PAGADOR|TRANSPORTISTA|CARTA DE PORTE|DOMINIO|DECLARACION|JURADA|SECCION)\b/gi, '').replace(/\s+/g, ' ').trim();
        }

        return res.json({
            success: true,
            datos: { ctg, chasis, acoplado, chofer }
        });

    } catch (error) {
        console.error("Error al procesar el archivo:", error.message);
        return res.json({ success: false, message: 'No se pudo leer el archivo completamente.' });
    }
});

// Consulta Web Oficial a ARCA/AFIP usando Puppeteer
app.post('/api/consultar-cpe', async (req, res) => {
    const { ctg } = req.body;

    if (!ctg) {
        return res.status(400).json({ success: false, message: 'Ingrese un número de CTG o CPE' });
    }

    let browser = null;
    try {
        console.log(`Iniciando Puppeteer para consultar CTG ${ctg} en ARCA/AFIP...`);
        
        const launchOptions = {
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        };

        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }

        browser = await puppeteer.launch(launchOptions);

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const targetUrl = `https://serviciosweb.afip.gob.ar/cpe/consultarCpe.aspx?nroCpe=${ctg}`;
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });

        const datos = await page.evaluate(() => {
            const bodyText = document.body.innerText || '';

            const patentes = bodyText.match(/\b([A-Z]{2}\d{3}[A-Z]{2}|[A-Z]{3}\d{3})\b/gi) || [];
            
            let chofer = '';
            const matchChofer = bodyText.match(/Chofer\s*:?\s*(?:\d{11}|\d{2}-\d{8}-\d{1})?\s*[-:\s]*([A-Z\s]{5,40})/i);
            if (matchChofer && matchChofer[1]) chofer = matchChofer[1].trim();

            return {
                chasis: patentes[0] || '',
                acoplado: patentes[1] || '',
                chofer: chofer
            };
        });

        await browser.close();

        return res.json({
            success: true,
            datos: {
                ctg: ctg,
                chasis: datos.chasis.replace(/[\s-]/g, '').toUpperCase(),
                acoplado: datos.acoplado.replace(/[\s-]/g, '').toUpperCase(),
                chofer: datos.chofer
            }
        });

    } catch (error) {
        if (browser) await browser.close();
        console.error("Error consultando ARCA con Puppeteer:", error.message);
        return res.status(500).json({ 
            success: false, 
            message: 'No se pudieron consultar los datos oficiales de ARCA en este momento.' 
        });
    }
});

// Obtener turnos
app.get('/api/turnos', (req, res) => res.json(turnos));

// Registrar turno
app.post('/api/turnos', uploadDisco.single('adjunto'), (req, res) => {
    try {
        const {
            tipo_operacion,
            tipo_documento,
            dominio_chasis,
            dominio_acoplado,
            chofer_nombre,
            chofer_telefono,
            detalles_doc
        } = req.body;

        const nuevoId = turnos.length > 0 ? Math.max(...turnos.map(t => t.id)) + 1 : 1;
        const numTurno = String(nuevoId).padStart(3, '0');
        const codigoTurno = `T-${numTurno}`;

        const nuevoTurno = {
            id: nuevoId,
            codigo_turno: codigoTurno,
            tipo_operacion: tipo_operacion || 'DESCARGA',
            tipo_documento: tipo_documento || 'CARTA_DE_PORTE',
            dominio_chasis: (dominio_chasis || '').toUpperCase(),
            dominio_acoplado: (dominio_acoplado || '').toUpperCase(),
            chofer_nombre: chofer_nombre || '',
            chofer_telefono: chofer_telefono || '',
            detalles_doc: detalles_doc || '',
            adjunto_path: req.file ? `/uploads/${req.file.filename}` : null,
            estado: 'ESPERANDO',
            fecha_creacion: new Date().toISOString()
        };

        turnos.push(nuevoTurno);
        guardarTurnos();

        io.emit('nuevo_turno', nuevoTurno);
        return res.json({ success: true, turno: nuevoTurno });
    } catch (err) {
        console.error("Error al registrar turno:", err);
        return res.status(500).json({ success: false, message: 'Error al registrar turno' });
    }
});

// Cambiar estado
app.post('/api/turnos/estado', (req, res) => {
    const { id, estado } = req.body;
    const turno = turnos.find(t => t.id === parseInt(id));

    if (turno) {
        turno.estado = estado;
        const timestamp = new Date().toISOString();
        if (estado === 'EN_TRANSITO') turno.fecha_llamado = timestamp;

        guardarTurnos();
        io.emit('cambio_estado', { id: turno.id, estado: turno.estado, timestamp });
        return res.json({ success: true, turno });
    }

    return res.status(404).json({ success: false, message: 'Turno no encontrado' });
});

io.on('connection', (socket) => console.log('Cliente Socket.io conectado:', socket.id));

server.listen(PORT, () => console.log(`Servidor activo en http://localhost:${PORT}`));