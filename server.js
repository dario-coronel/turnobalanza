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
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// =========================================================================
// 1. LIMPIEZA PREVENTIVA DE LOCKS DE CHROMIUM
// =========================================================================
const authDataPath = path.join(__dirname, '.wwebjs_auth');
function limpiarLocksChromium(dir) {
    if (!fs.existsSync(dir)) return;
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                limpiarLocksChromium(fullPath);
            } else if (file.startsWith('Singleton')) {
                try { fs.unlinkSync(fullPath); } catch (e) {}
            }
        }
    } catch (e) {}
}
limpiarLocksChromium(authDataPath);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Directorios y Archivos de Persistencia
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const certsDir = path.join(__dirname, 'afip_certs');
if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

const CONFIG_FILE = path.join(__dirname, 'config.json');
const USERS_FILE = path.join(__dirname, 'usuarios.json');
const ROLES_FILE = path.join(__dirname, 'roles.json');
const DATA_FILE = path.join(__dirname, 'turnos.json');

// Cargar o Inicializar Configuración
let appConfig = {
    smtp: {
        host: "vnct6009.avnam.net",
        port: 465,
        secure: true,
        user: "it@edpagro.com.ar",
        pass: "Edp-1234",
        from: '"Balanza EDP Agroindustrial" <it@edpagro.com.ar>'
    },
    jwtSecret: "balanza_secret_jwt_key_2026_edp"
};

if (fs.existsSync(CONFIG_FILE)) {
    try { appConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
} else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
}

function guardarConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
}

// Cargar o Inicializar Roles del Sistema
function inicializarRoles() {
    let roles = [];
    if (fs.existsSync(ROLES_FILE)) {
        try { roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8')); } catch (e) { roles = []; }
    }
    if (!Array.isArray(roles) || roles.length === 0) {
        roles = [
            { codigo: "admin", nombre: "Administrador", descripcion: "Acceso total a módulos y configuración", permisos: ["dashboard", "gestion", "configuracion"] },
            { codigo: "balanza", nombre: "Operador de Balanza", descripcion: "Operación de pesaje en tiempo real", permisos: ["dashboard"] },
            { codigo: "planta", nombre: "Supervisión de Planta", descripcion: "Control de pesaje y analítica operativa", permisos: ["dashboard", "gestion"] }
        ];
        fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
    }
    return roles;
}

function obtenerRoles() {
    if (fs.existsSync(ROLES_FILE)) {
        try { return JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8')); } catch (e) { return []; }
    }
    return inicializarRoles();
}

function guardarRoles(roles) {
    fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
}

// Cargar o Inicializar Usuarios con Clave Admin123!
function inicializarUsuarios() {
    let users = [];
    if (fs.existsSync(USERS_FILE)) {
        try {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            let modificado = false;
            users = users.map(u => {
                if (typeof u.activo === 'undefined') {
                    u.activo = true;
                    modificado = true;
                }
                return u;
            });
            if (modificado) fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        } catch (e) {
            users = [];
        }
    }

    if (!Array.isArray(users) || users.length === 0) {
        const passHash = bcrypt.hashSync("Admin123!", 10);
        users = [
            { id: 1, username: "admin", nombre: "Administrador", email: "it@edpagro.com.ar", password: passHash, rol: "admin", activo: true, resetToken: null, resetExpires: null },
            { id: 2, username: "balanza", nombre: "Operador Balanza", email: "balanza@edpagro.com.ar", password: passHash, rol: "balanza", activo: true, resetToken: null, resetExpires: null },
            { id: 3, username: "planta", nombre: "Supervisión Planta", email: "planta@edpagro.com.ar", password: passHash, rol: "planta", activo: true, resetToken: null, resetExpires: null }
        ];
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    }
    return users;
}

function obtenerUsuarios() {
    if (fs.existsSync(USERS_FILE)) {
        try { 
            const list = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            return list.map(u => ({ ...u, activo: u.activo !== false }));
        } catch (e) { return []; }
    }
    return inicializarUsuarios();
}

function guardarUsuarios(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

inicializarRoles();
inicializarUsuarios();

// Cargar Turnos
let turnos = [];
if (fs.existsSync(DATA_FILE)) {
    try { turnos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { turnos = []; }
}
function guardarTurnos() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(turnos, null, 2));
}

// Multer
const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadMemoria = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadDisco = multer({ storage: diskStorage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// =========================================================================
// MIDDLEWARES DE SEGURIDAD Y CONTROL DE ACCESO BASADO EN PERMISOS (RBAC)
// =========================================================================
function verificarAutenticacion(req, res, next) {
    const token = req.cookies.auth_token;
    if (!token) return res.redirect('/login');

    try {
        const decoded = jwt.verify(token, appConfig.jwtSecret);
        req.user = decoded;
        next();
    } catch (err) {
        res.clearCookie('auth_token');
        return res.redirect('/login');
    }
}

function verificarPermisoModulo(moduloRequerido) {
    return (req, res, next) => {
        if (!req.user) return res.redirect('/login');
        
        const userRol = String(req.user.rol || '').trim().toLowerCase();
        if (userRol === 'admin') return next();

        const roles = obtenerRoles();
        const rolDef = roles.find(r => r.codigo.toLowerCase() === userRol);

        if (rolDef && Array.isArray(rolDef.permisos) && rolDef.permisos.includes(moduloRequerido)) {
            return next();
        }

        return res.status(403).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">403 - Acceso no autorizado para su perfil. <br><a href="/menu">Volver al Menú</a></h2>');
    };
}

// =========================================================================
// SERVICIO DE CORREO SMTP
// =========================================================================
function crearTransporterSMTP(customConfig = null) {
    const cfg = customConfig || appConfig.smtp;
    return nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: {
            user: cfg.user,
            pass: cfg.pass
        },
        tls: { rejectUnauthorized: false }
    });
}

// =========================================================================
// ENDPOINTS DE AUTENTICACIÓN Y SESIÓN
// =========================================================================
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const listaUsuarios = obtenerUsuarios();

    const user = listaUsuarios.find(u => u.username.toLowerCase() === (username || '').toLowerCase().trim());

    if (!user) {
        return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos.' });
    }

    if (user.activo === false) {
        return res.status(403).json({ success: false, message: 'Su cuenta se encuentra desactivada. Contacte al administrador.' });
    }

    const passwordValida = await bcrypt.compare(password, user.password);
    if (!passwordValida) {
        return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos.' });
    }

    const rolNormalizado = (user.rol || 'balanza').trim().toLowerCase();

    const token = jwt.sign(
        { id: user.id, username: user.username, nombre: user.nombre, rol: rolNormalizado },
        appConfig.jwtSecret,
        { expiresIn: '12h' }
    );

    res.cookie('auth_token', token, {
        httpOnly: true,
        maxAge: 12 * 60 * 60 * 1000,
        sameSite: 'lax'
    });

    return res.json({ success: true, rol: rolNormalizado });
});

app.get('/api/auth/me', verificarAutenticacion, (req, res) => {
    const roles = obtenerRoles();
    const rolDef = roles.find(r => r.codigo.toLowerCase() === req.user.rol.toLowerCase());

    return res.json({
        id: req.user.id,
        username: req.user.username,
        nombre: req.user.nombre,
        rol: req.user.rol,
        permisos: rolDef ? rolDef.permisos : (req.user.rol === 'admin' ? ['dashboard', 'gestion', 'configuracion'] : ['dashboard'])
    });
});

app.get('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    return res.redirect('/login');
});

// Recuperación de Contraseñas
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    const listaUsuarios = obtenerUsuarios();
    const user = listaUsuarios.find(u => u.email.toLowerCase() === (email || '').toLowerCase().trim());

    if (!user || user.activo === false) {
        return res.json({ success: true, message: 'Si el correo está registrado y activo, se enviaron las instrucciones.' });
    }

    const resetToken = crypto.randomBytes(24).toString('hex');
    user.resetToken = resetToken;
    user.resetExpires = Date.now() + 30 * 60 * 1000;
    guardarUsuarios(listaUsuarios);

    const hostReq = req.get('host');
    const protocol = req.protocol;
    const resetUrl = `${protocol}://${hostReq}/recuperar?token=${resetToken}`;

    try {
        const transporter = crearTransporterSMTP();
        await transporter.sendMail({
            from: appConfig.smtp.from,
            to: user.email,
            subject: 'Recuperación de Contraseña - Balanza EDP Agroindustrial',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                    <h2 style="color: #2563eb;">Restablecimiento de Contraseña</h2>
                    <p>Hola <b>${user.nombre}</b>,</p>
                    <p>Haga clic en el enlace para generar su nueva clave (válido por 30 minutos):</p>
                    <p style="text-align: center; margin: 25px 0;">
                        <a href="${resetUrl}" style="background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 5px; font-weight: bold;">Restablecer Contraseña</a>
                    </p>
                </div>
            `
        });
        return res.json({ success: true, message: 'Se han enviado las instrucciones a su casilla de correo.' });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error al despachar el correo SMTP.' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { token, password } = req.body;
    const listaUsuarios = obtenerUsuarios();
    const user = listaUsuarios.find(u => u.resetToken === token && u.resetExpires > Date.now());

    if (!user) {
        return res.status(400).json({ success: false, message: 'El enlace es inválido o ha expirado.' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    user.resetToken = null;
    user.resetExpires = null;
    guardarUsuarios(listaUsuarios);

    return res.json({ success: true, message: 'Contraseña actualizada con éxito.' });
});

// =========================================================================
// CRUD DE USUARIOS (CON TRAZABILIDAD)
// =========================================================================
app.get('/api/admin/usuarios', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    const listaUsuarios = obtenerUsuarios();
    const sanitizados = listaUsuarios.map(u => ({
        id: u.id,
        username: u.username,
        nombre: u.nombre,
        email: u.email,
        rol: u.rol,
        activo: u.activo !== false
    }));
    res.json(sanitizados);
});

app.post('/api/admin/usuarios', verificarAutenticacion, verificarPermisoModulo('configuracion'), async (req, res) => {
    try {
        const { username, nombre, email, password, rol } = req.body;
        const listaUsuarios = obtenerUsuarios();

        if (!username || !password || !email || !rol) {
            return res.status(400).json({ success: false, message: 'Complete todos los campos obligatorios.' });
        }

        const usernameLimpio = username.trim().toLowerCase();
        const emailLimpio = email.trim().toLowerCase();

        const existe = listaUsuarios.find(u => u.username.toLowerCase() === usernameLimpio || u.email.toLowerCase() === emailLimpio);
        if (existe) {
            return res.status(400).json({ success: false, message: 'El nombre de usuario o email ya existe.' });
        }

        const passHash = await bcrypt.hash(password, 10);
        const nuevoId = listaUsuarios.length > 0 ? Math.max(...listaUsuarios.map(u => u.id)) + 1 : 1;

        const nuevoUsuario = {
            id: nuevoId,
            username: usernameLimpio,
            nombre: nombre ? nombre.trim() : usernameLimpio,
            email: emailLimpio,
            password: passHash,
            rol: rol.trim().toLowerCase(),
            activo: true,
            resetToken: null,
            resetExpires: null
        };

        listaUsuarios.push(nuevoUsuario);
        guardarUsuarios(listaUsuarios);

        return res.json({ success: true, message: 'Usuario creado exitosamente.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Error interno al crear usuario.' });
    }
});

app.put('/api/admin/usuarios/:id', verificarAutenticacion, verificarPermisoModulo('configuracion'), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { nombre, email, rol, password } = req.body;
        const listaUsuarios = obtenerUsuarios();

        const user = listaUsuarios.find(u => u.id === id);
        if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });

        if (nombre) user.nombre = nombre.trim();
        if (email) user.email = email.trim().toLowerCase();
        if (rol) user.rol = rol.trim().toLowerCase();
        if (password && password.trim().length > 0) {
            user.password = await bcrypt.hash(password.trim(), 10);
        }

        guardarUsuarios(listaUsuarios);
        return res.json({ success: true, message: 'Usuario actualizado correctamente.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Error al actualizar usuario.' });
    }
});

app.patch('/api/admin/usuarios/:id/toggle-estado', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    const id = parseInt(req.params.id);
    const listaUsuarios = obtenerUsuarios();

    const user = listaUsuarios.find(u => u.id === id);
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });

    if (user.id === req.user.id) {
        return res.status(400).json({ success: false, message: 'No puede desactivar su propia cuenta en uso.' });
    }

    user.activo = !user.activo;
    guardarUsuarios(listaUsuarios);

    const estadoTexto = user.activo ? 'reactivado' : 'desactivado';
    return res.json({ success: true, message: `Usuario ${user.username} ${estadoTexto}.`, activo: user.activo });
});

// =========================================================================
// CRUD DE ROLES Y MATRIZ DE PERMISOS
// =========================================================================
app.get('/api/admin/roles', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    res.json(obtenerRoles());
});

app.post('/api/admin/roles', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    try {
        const { codigo, nombre, descripcion, permisos } = req.body;
        const roles = obtenerRoles();

        if (!codigo || !nombre) {
            return res.status(400).json({ success: false, message: 'Código y Nombre son requeridos.' });
        }

        const codLimpio = codigo.trim().toLowerCase().replace(/\s+/g, '_');
        if (roles.find(r => r.codigo.toLowerCase() === codLimpio)) {
            return res.status(400).json({ success: false, message: `Ya existe un rol con el código "${codLimpio}".` });
        }

        const nuevoRol = {
            codigo: codLimpio,
            nombre: nombre.trim(),
            descripcion: descripcion ? descripcion.trim() : '',
            permisos: Array.isArray(permisos) ? permisos : ['dashboard']
        };

        roles.push(nuevoRol);
        guardarRoles(roles);

        return res.json({ success: true, message: 'Rol creado exitosamente.', rol: nuevoRol });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Error al procesar el rol.' });
    }
});

app.put('/api/admin/roles/:codigo', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    try {
        const cod = req.params.codigo.trim().toLowerCase();
        const { nombre, descripcion, permisos } = req.body;
        const roles = obtenerRoles();

        const rol = roles.find(r => r.codigo.toLowerCase() === cod);
        if (!rol) return res.status(404).json({ success: false, message: 'Rol no encontrado.' });

        if (nombre) rol.nombre = nombre.trim();
        if (typeof descripcion !== 'undefined') rol.descripcion = descripcion.trim();
        if (Array.isArray(permisos)) rol.permisos = permisos;

        guardarRoles(roles);
        return res.json({ success: true, message: 'Rol y permisos actualizados correctamente.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Error al actualizar el rol.' });
    }
});

app.delete('/api/admin/roles/:codigo', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    const cod = req.params.codigo.trim().toLowerCase();
    if (cod === 'admin') {
        return res.status(400).json({ success: false, message: 'No se puede eliminar el rol Administrador del sistema.' });
    }

    let roles = obtenerRoles();
    roles = roles.filter(r => r.codigo.toLowerCase() !== cod);
    guardarRoles(roles);

    return res.json({ success: true, message: 'Rol eliminado correctamente.' });
});

// =========================================================================
// CONFIGURACIÓN SMTP & TEST
// =========================================================================
app.get('/api/admin/config/smtp', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    res.json(appConfig.smtp);
});

app.post('/api/admin/config/smtp', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    const { host, port, secure, user, pass, from } = req.body;
    appConfig.smtp = {
        host: host.trim(),
        port: Number(port),
        secure: Boolean(secure),
        user: user.trim(),
        pass: pass,
        from: from || `\"Balanza EDP\" <${user.trim()}>`
    };
    guardarConfig();
    res.json({ success: true, message: 'Parámetros SMTP guardados exitosamente.' });
});

app.post('/api/admin/test-smtp', verificarAutenticacion, verificarPermisoModulo('configuracion'), async (req, res) => {
    const { host, port, secure, user, pass, testEmail } = req.body;
    const testCfg = {
        host: host.trim(),
        port: Number(port),
        secure: Boolean(secure),
        user: user.trim(),
        pass: pass
    };

    try {
        const transporter = crearTransporterSMTP(testCfg);
        await transporter.verify();
        await transporter.sendMail({
            from: `\"Balanza EDP Test\" <${user.trim()}>`,
            to: testEmail || user.trim(),
            subject: 'Prueba de Conexión SMTP Exitosa - Balanza EDP',
            text: 'Este es un correo de prueba emitido desde la configuración del sistema de Balanza.'
        });
        return res.json({ success: true, message: '¡Conexión verificada y correo de prueba enviado con éxito!' });
    } catch (err) {
        return res.status(400).json({ success: false, message: `Fallo SMTP: ${err.message}` });
    }
});

// =========================================================================
// RUTAS Y VISTAS
// =========================================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/recuperar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recuperar.html')));

app.get('/menu', verificarAutenticacion, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

app.get('/dashboard', verificarAutenticacion, verificarPermisoModulo('dashboard'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/gestion', verificarAutenticacion, verificarPermisoModulo('gestion'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gestion.html'));
});

app.get('/configuracion', verificarAutenticacion, verificarPermisoModulo('configuracion'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configuracion.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// AFIP / ARCA SDK
let afip = null;
const certPath = path.join(certsDir, 'cert.crt');
const keyPath = path.join(certsDir, 'cert.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
        afip = new Afip({ CUIT: 30123456789, cert: certPath, key: keyPath, production: true });
        console.log("✅ SDK AFIP/ARCA inicializado.");
    } catch (e) {
        afip = null;
    }
}

// BOT WHATSAPP
let isWaReady = false;
let currentWaNumber = null;
let currentQrDataUrl = null;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

const waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        executablePath: CHROMIUM_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    }
});

waClient.on('qr', async (qr) => {
    try {
        currentQrDataUrl = await QRCode.toDataURL(qr);
        isWaReady = false;
        io.emit('wa_status', { ready: false, qr: currentQrDataUrl, number: null });
    } catch (err) {}
});

waClient.on('ready', () => {
    isWaReady = true;
    currentQrDataUrl = null;
    currentWaNumber = waClient.info && waClient.info.wid ? waClient.info.wid.user : 'Conectado';
    console.log(`✅ WhatsApp conectado (+${currentWaNumber}).`);
    io.emit('wa_status', { ready: true, qr: null, number: currentWaNumber });
});

waClient.on('auth_failure', () => io.emit('wa_status', { ready: false, qr: null, number: null }));
waClient.on('disconnected', () => {
    isWaReady = false;
    io.emit('wa_status', { ready: false, qr: null, number: null });
    limpiarLocksChromium(authDataPath);
    try { waClient.initialize(); } catch (e) {}
});

async function enviarWhatsAppAutomatico(telefono, mensaje) {
    if (!isWaReady) return false;
    try {
        let numLimpio = String(telefono).replace(/\D/g, '');
        if (numLimpio.startsWith('0')) numLimpio = numLimpio.substring(1);
        if (numLimpio.startsWith('15')) numLimpio = numLimpio.substring(2);

        let numConPrefijo = numLimpio;
        if (!numConPrefijo.startsWith('549')) {
            if (numConPrefijo.startsWith('54')) numConPrefijo = '549' + numConPrefijo.slice(2);
            else numConPrefijo = '549' + numConPrefijo;
        }

        let idInfo = await waClient.getNumberId(numConPrefijo);
        if (!idInfo && numConPrefijo.startsWith('549')) {
            idInfo = await waClient.getNumberId('54' + numConPrefijo.slice(3));
        }

        const chatId = idInfo ? idInfo._serialized : `${numConPrefijo}@c.us`;
        await waClient.sendMessage(chatId, mensaje);
        console.log(`[WHATSAPP ENVIADO] A: ${chatId}`);
        return true;
    } catch (err) {
        return false;
    }
}

app.get('/api/wa-status', (req, res) => {
    res.json({ ready: isWaReady, qr: currentQrDataUrl, number: currentWaNumber });
});

app.post('/api/wa-logout', async (req, res) => {
    try {
        isWaReady = false;
        io.emit('wa_status', { ready: false, qr: null, number: null });
        try { await waClient.logout(); } catch (e) { await waClient.destroy(); }
        limpiarLocksChromium(authDataPath);
        setTimeout(() => { waClient.initialize(); }, 1000);
        return res.json({ success: true });
    } catch (err) {
        return res.json({ success: true });
    }
});

// OCR & CONSULTAS
function extraerTextoPdfNativo(buffer) {
    let textoCompleto = buffer.toString('latin1');
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;
    while ((match = streamRegex.exec(buffer.toString('latin1'))) !== null) {
        try {
            const streamBuffer = Buffer.from(match[1], 'latin1');
            const decompressed = zlib.inflateSync(streamBuffer).toString('latin1');
            const partesTexto = decompressed.match(/\((.*?)\)/g);
            if (partesTexto) textoCompleto += '\n' + partesTexto.map(t => t.replace(/[()]/g, '')).join(' ');
            textoCompleto += '\n' + decompressed;
        } catch (e) {}
    }
    return textoCompleto;
}

async function extraerTextoImagenOCR(buffer) {
    try {
        const bufferOptimizado = await sharp(buffer).resize({ width: 1600, fit: 'inside', withoutEnlargement: true }).grayscale().normalize().toBuffer();
        const worker = await createWorker('spa');
        const ret = await worker.recognize(bufferOptimizado);
        await worker.terminate();
        return ret.data.text;
    } catch (e) { return ""; }
}

app.post('/api/procesar-archivo', uploadMemoria.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No se subió archivo' });
        let textoExtraido = (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf'))
            ? extraerTextoPdfNativo(req.file.buffer)
            : await extraerTextoImagenOCR(req.file.buffer);

        let ctg = '', chasis = '', acoplado = '', chofer = '', producto = '';
        const matchCTG = textoExtraido.match(/CTG:?\s*(\d{10,12})/i) || textoExtraido.match(/\b(10\d{9,10})\b/);
        if (matchCTG) ctg = matchCTG[1] || matchCTG[0];

        const patentesEncontradas = textoExtraido.match(/\b([A-Z]{2}\s?\d{3}\s?[A-Z]{2}|[A-Z]{3}\s?\d{3})\b/gi);
        if (patentesEncontradas && patentesEncontradas.length > 0) {
            const patentesLimpias = [...new Set(patentesEncontradas.map(p => p.replace(/\s+/g, '').toUpperCase()))];
            chasis = patentesLimpias[0] || '';
            if (patentesLimpias.length > 1) acoplado = patentesLimpias[1] || '';
        }

        let matchChofer = textoExtraido.match(/Chofer\s*:?\s*(?:\d{11}|\d{2}-\d{8}-\d{1})?\s*[-:\s]*([A-ZÁÉÍÓÚÑ\s]{5,40})/i);
        if (matchChofer && matchChofer[1]) chofer = matchChofer[1].trim();

        const matchProducto = textoExtraido.match(/(SOJA|GIRASOL|MAIZ|MAÍZ|TRIGO|CEBADA|SORGO)/i);
        if (matchProducto) producto = matchProducto[1].toUpperCase().includes('MAI') ? 'MAIZ' : matchProducto[1].toUpperCase();

        return res.json({ success: (ctg || chasis || chofer || producto) ? true : false, datos: { ctg, chasis, acoplado, chofer, producto } });
    } catch (error) {
        return res.json({ success: false });
    }
});

app.post('/api/consultar-cpe', async (req, res) => {
    let { ctg } = req.body;
    if (!ctg) return res.status(400).json({ success: false, message: 'Ingrese CTG' });
    const matchNum = String(ctg).match(/\b(10\d{9,10}|\d{10,12})\b/);
    ctg = matchNum ? matchNum[0] : String(ctg).replace(/\D/g, '');

    if (afip && afip.options) {
        try {
            const wsCpe = afip.WebService('ws_cpe');
            const respuestaAfip = await wsCpe.executeRequest('consultarCpe', { cpe: { nroCpe: Number(ctg) } });
            if (respuestaAfip) {
                return res.json({
                    success: true,
                    datos: {
                        ctg,
                        chasis: respuestaAfip.dominioChasis || respuestaAfip.chasis || '',
                        acoplado: respuestaAfip.dominioAcoplado || respuestaAfip.acoplado || '',
                        chofer: respuestaAfip.nombreChofer || respuestaAfip.chofer || ''
                    }
                });
            }
        } catch (errAfip) {
            return res.json({ success: false, message: errAfip.message });
        }
    }
    return res.json({ success: false, message: 'AFIP no configurado' });
});

app.get('/api/turnos', (req, res) => res.json(turnos));

// REGISTRO DE TURNOS
app.post('/api/turnos', uploadDisco.single('adjunto'), (req, res) => {
    try {
        const { tipo_operacion, tipo_documento, dominio_chasis, dominio_acoplado, chofer_nombre, chofer_telefono, detalles_doc, producto_carga } = req.body;
        const ahora = new Date();
        const ahoraIso = ahora.toISOString();
        const mesString = String(ahora.getMonth() + 1).padStart(2, '0');

        const turnosDelMes = turnos.filter(t => t.fecha_ingreso_playa && new Date(t.fecha_ingreso_playa).getMonth() + 1 === (ahora.getMonth() + 1));
        let maxCorrelativo = 0;
        const patron = new RegExp(`^T-${mesString}(\\d{3})$`);
        turnosDelMes.forEach(t => {
            const m = String(t.codigo_turno).match(patron);
            if (m && parseInt(m[1], 10) > maxCorrelativo) maxCorrelativo = parseInt(m[1], 10);
        });

        const codigoTurno = `T-${mesString}${String(maxCorrelativo + 1).padStart(3, '0')}`;
        const nuevoTurno = {
            id: turnos.length > 0 ? Math.max(...turnos.map(t => t.id)) + 1 : 1,
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
            fecha_ingreso_playa: ahoraIso,
            fecha_llamado_balanza: null,
            fecha_ingreso_balanza: null,
            fecha_ingreso_planta: null,
            fecha_salida_balanza: null,
            reencolado_cant: 0
        };

        turnos.push(nuevoTurno);
        guardarTurnos();
        io.emit('nuevo_turno', nuevoTurno);

        if (chofer_telefono) {
            enviarWhatsAppAutomatico(chofer_telefono, `✅ *TURNO REGISTRADO EN PLAYA*\n\n*Turno:* ${codigoTurno}\n*Dominio:* ${nuevoTurno.dominio_chasis}\n\nAguarde en playa a ser llamado a Balanza.`).catch(() => {});
        }
        return res.json({ success: true, turno: nuevoTurno });
    } catch (err) {
        return res.status(500).json({ success: false });
    }
});

app.post('/api/turnos/estado', verificarAutenticacion, async (req, res) => {
    const { id, estado } = req.body;
    const turno = turnos.find(t => t.id === parseInt(id));

    if (turno) {
        const timestamp = new Date().toISOString();
        if (estado === 'EN_TRANSITO') {
            turno.estado = 'EN_TRANSITO';
            turno.fecha_llamado_balanza = timestamp;
            if (turno.chofer_telefono) {
                enviarWhatsAppAutomatico(turno.chofer_telefono, `🚛 *LLAMADO A BALANZA*\n\nHola ${turno.chofer_nombre || ''}! Su turno *${turno.codigo_turno}* (${turno.dominio_chasis}) ha sido llamado a BALANZA.`).catch(() => {});
            }
        } else if (estado === 'EN_BALANZA') {
            turno.estado = 'EN_BALANZA';
            if (!turno.fecha_ingreso_balanza) turno.fecha_ingreso_balanza = timestamp;
        } else if (estado === 'EN_PLANTA_TARA') {
            turno.estado = 'EN_PLANTA_TARA';
            turno.fecha_ingreso_planta = timestamp;
            if (turno.chofer_telefono) {
                enviarWhatsAppAutomatico(turno.chofer_telefono, `📦 *INGRESO A PLANTA*\n\nTurno *${turno.codigo_turno}*: Diríjase al sector asignado. Al finalizar aguarde el llamado de Tara.`).catch(() => {});
            }
        } else if (estado === 'FINALIZADO') {
            turno.estado = 'FINALIZADO';
            turno.fecha_salida_balanza = timestamp;
            if (turno.chofer_telefono) {
                enviarWhatsAppAutomatico(turno.chofer_telefono, `⚖️ *PESAJE FINALIZADO - EDP AGROINDUSTRIAL*\n\nHola ${turno.chofer_nombre || 'Chofer'}, pesaje completado. ¡Buen viaje!`).catch(() => {});
            }
        } else if (estado === 'RE_ENCOLADO') {
            turno.estado = 'ESPERANDO';
            turno.reencolado_cant = (turno.reencolado_cant || 0) + 1;
            if (turno.chofer_telefono) {
                enviarWhatsAppAutomatico(turno.chofer_telefono, `⚠️ *TURNO RE-ENCOLADO*\n\nSu turno *${turno.codigo_turno}* ha regresado a la lista de espera por no presentarse a tiempo.`).catch(() => {});
            }
        }

        guardarTurnos();
        io.emit('cambio_estado', { id: turno.id, estado: turno.estado, timestamp });
        return res.json({ success: true, turno });
    }
    return res.status(404).json({ success: false });
});

io.on('connection', (socket) => {
    socket.emit('wa_status', { ready: isWaReady, qr: currentQrDataUrl, number: currentWaNumber });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor TurnoBalanza activo en http://0.0.0.0:${PORT}`);
    waClient.initialize();
});