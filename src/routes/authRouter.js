const express = require("express");
const db = require("../services/db");
const bcrypt = require("bcrypt");
const moment = require("moment");
const path = require("path");
const yaml = require("js-yaml");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const nodemailer = require("nodemailer");
const router = express.Router();
const rateLimit = require("express-rate-limit");

require("moment/locale/es")
moment.locale('es');

// Cargar configuración de hCaptcha
const loadHcaptchaConfig = () => {
  try {
    const filePath = path.join(__dirname, "..", "config", "hcaptcha.yml");
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const config = yaml.load(fileContents);
    const env = process.env.NODE_ENV || 'development';
    return config[env];
  } catch (e) {
    console.error('Error al cargar la configuración de hCaptcha:', e);
    // Valores por defecto para desarrollo
    return {
      site_key: "10000000-ffff-ffff-ffff-000000000001",
      secret_key: "0x0000000000000000000000000000000000000000"
    };
  }
};

const hcaptchaConfig = loadHcaptchaConfig();

// Configuración de multer para almacenar archivos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = "./src/public/uploads/";
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

// Configuración del rate limit para la ruta de inicio de sesión
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Limita cada IP a 5 solicitudes por ventana de tiempo
  skipSuccessfulRequests: true, // No cuenta los intentos exitosos
  standardHeaders: true, // Devuelve info de rate limit en los headers
  legacyHeaders: false, // Deshabilita los headers `X-RateLimit-*` 
  message: {
    status: 429,
    message: 'Demasiados intentos fallidos'
  },
  handler: (req, res) => {
    const remainingTime = Math.ceil(req.rateLimit.resetTime / 1000 / 60);
    res.render("users/login", {
      errorMessage: `Demasiados intentos de inicio de sesión desde esta IP. Por favor espera ${remainingTime} minutos antes de intentar nuevamente.`,
      captchaPhrase: req.session.captchaPhrase || null,
      remainingAttempts: req.rateLimit.remaining
    });
  }
});

// Ruta de registro (GET)
router.get("/register", (req, res) => {
  res.render("users/register", { 
    error: null,
    HCAPTCHA_SITE_KEY: hcaptchaConfig.site_key
  });
});

// Ruta de registro (POST)
router.post("/register", async (req, res) => {
  const { username, email, password, 'h-captcha-response': hcaptchaResponse } = req.body;
  
  // Verificar hCaptcha
  if (!hcaptchaResponse) {
    return res.render("users/register", {
      error: "Por favor, completa el captcha",
      HCAPTCHA_SITE_KEY: hcaptchaConfig.site_key
    });
  }

  try {
    const verifyUrl = 'https://hcaptcha.com/siteverify';
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `response=${hcaptchaResponse}&secret=${hcaptchaConfig.secret_key}`
    });

    const data = await response.json();
    if (!data.success) {
      return res.render("users/register", {
        error: "Verificación del captcha fallida",
        HCAPTCHA_SITE_KEY: hcaptchaConfig.site_key
      });
    }

    // Continuar con el registro existente...
    const createdAt = new Date();

    // Validar el dominio del correo electrónico
    const allowedDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    const emailDomain = email.split('@')[1]?.toLowerCase();
    
    if (!allowedDomains.includes(emailDomain)) {
      return res.render("users/register", {
        error: "Solo se permiten correos de Gmail, Yahoo, Hotmail y Outlook."
      });
    }

    // Obtener la IP real del cliente desde el encabezado de Cloudflare
    const ipAddress =
      req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.connection.remoteAddress;

    // Verificar si ya existen 3 o más cuentas desde la misma IP
    const checkIpSql = "SELECT COUNT(*) AS count FROM usuarios WHERE ip_address = ?";
    db.query(checkIpSql, [ipAddress], (err, results) => {
      if (err) {
        console.error("Error al verificar la IP:", err);
        return res.render("users/register", {
          error: "Error al procesar la solicitud. Por favor, inténtalo de nuevo."
        });
      }

      if (results[0].count >= 3) {
        return res.render("users/register", {
          error: "Se ha excedido el límite de cuentas permitidas desde esta IP.",
        });
      }

      // Verificar si el nombre de usuario o el correo electrónico ya están en uso
      const checkUserSql = "SELECT * FROM usuarios WHERE username = ? OR email = ?";
      db.query(checkUserSql, [username, email], (err, userResults) => {
        if (err) {
          console.error("Error al verificar el usuario:", err);
          return res.render("users/register", {
            error: "Error al procesar la solicitud. Por favor, inténtalo de nuevo."
          });
        }

        // Manejar errores de nombre de usuario y correo electrónico
        if (userResults.length > 0) {
          if (userResults.some(user => user.username === username)) {
            return res.render("users/register", {
              error: "El nombre de usuario ya está en uso."
            });
          }
          if (userResults.some(user => user.email === email)) {
            return res.render("users/register", {
              error: "El correo electrónico ya está registrado."
            });
          }
        }

        // Encriptar la contraseña
        bcrypt.hash(password, 10, (err, hashedPassword) => {
          if (err) {
            console.error("Error al encriptar la contraseña:", err);
            return res.render("users/register", {
              error: "Error al procesar la solicitud. Por favor, inténtalo de nuevo."
            });
          }

          const sql = `INSERT INTO usuarios (username, email, password, created_at, is_admin, ip_address) VALUES (?, ?, ?, ?, ?, ?)`;
          db.query(
            sql,
            [username, email, hashedPassword, createdAt, false, ipAddress],
            (err, result) => {
              if (err) {
                console.error("Error al registrar el usuario:", err.message);
                if (err.code === "ER_NO_DEFAULT_FOR_FIELD") {
                  return res.render("users/register", {
                    error: "Por favor, proporciona una contraseña."
                  });
                } else {
                  return res.render("users/register", {
                    error: "Error al registrar el usuario. Por favor, inténtalo de nuevo."
                  });
                }
              }
              console.log("Usuario registrado correctamente");
              res.redirect("/login");
            }
          );
        });
      });
    });
  } catch (error) {
    console.error("Error al verificar hCaptcha:", error);
    return res.render("users/register", {
      error: "Error al verificar el captcha",
      HCAPTCHA_SITE_KEY: hcaptchaConfig.site_key
    });
  }
});


router.get("/api/auth/new-captcha", (req, res) => {
  try {
    const captchaPath = path.join(__dirname, "..", "config", "captcha.yml");
    const captchaData = yaml.load(fs.readFileSync(captchaPath, "utf8"));
    const words = captchaData.words;
    const randomIndex = Math.floor(Math.random() * words.length);
    const captchaPhrase = words[randomIndex];
    req.session.captchaPhrase = captchaPhrase;

    res.json({ captchaPhrase });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "Error al generar el captcha" });
  }
});

// Ruta de inicio de sesión (GET)
router.get("/login", (req, res) => {
  try {
    const captchaPath = path.join(__dirname, "..", "config", "captcha.yml");
    const captchaData = yaml.load(fs.readFileSync(captchaPath, "utf8"));
    const words = captchaData.words;
    const randomIndex = Math.floor(Math.random() * words.length);
    const captchaPhrase = words[randomIndex];
    req.session.captchaPhrase = captchaPhrase;

    // Asegúrate de pasar errorMessage aquí, si no hay, se define como null
    res.render("users/login", { captchaPhrase: captchaPhrase, errorMessage: null });
  } catch (e) {
    console.log(e);
    res.render("users/login", {
      errorMessage: "Error al cargar el captcha.",
      captchaPhrase: null, // O puedes definirlo como vacío
    });
  }
});

// Ruta de inicio de sesión (POST) con rate limit
router.post("/login", loginLimiter, (req, res) => {
  const { username, password, captchaInput } = req.body;
  const sql =
    "SELECT *, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS time_created, is_admin, banned, ban_expiration FROM usuarios WHERE username = ?";

  if (captchaInput !== req.session.captchaPhrase) {
    return res.render("users/login", {
      errorMessage: "Captcha incorrecto.",
      captchaPhrase: req.session.captchaPhrase,
    });
  }

  db.query(sql, [username], (err, results) => {
    if (err) {
      console.error("Error al iniciar sesión:", err.message);
      return res.render("users/login", {
        errorMessage: "Error al iniciar sesión. Inténtalo de nuevo.",
        captchaPhrase: req.session.captchaPhrase,
      });
    }

    if (results.length > 0) {
      const { password: hashedPassword, banned, ban_expiration } = results[0];

      // Verificar la contraseña encriptada
      bcrypt.compare(password, hashedPassword, (err, match) => {
        if (err) {
          console.error("Error al verificar la contraseña:", err);
          return res.render("users/login", {
            errorMessage: "Error al verificar la contraseña. Inténtalo de nuevo.",
            captchaPhrase: req.session.captchaPhrase,
          });
        }

        if (match) {
          // Verificar si el usuario está baneado
          if (banned) {
            if (ban_expiration > new Date()) {
              // Usuario baneado temporalmente
              const banExpirationFormatted = moment(ban_expiration).format("DD/MM/YYYY HH:mm:ss");
              return res.render("users/banned", {
                message: "Has sido baneado temporalmente.",
                banExpirationFormatted,
              });
            } else {
              // Usuario baneado permanentemente
              return res.render("users/banned", {
                message: "Has sido baneado permanentemente.",
                banExpirationFormatted: null,
              });
            }
          }

          // Usuario autorizado: almacenar datos en la cookie de sesión
          req.session.loggedin = true;
          req.session.userId = results[0].id;
          req.session.username = username;
          req.session.email = results[0].email;
          req.session.createdAt = results[0].created_at;
          req.session.timeCreated = results[0].time_created;
          req.session.isAdmin = results[0].is_admin;

          res.redirect("/anime");
        } else {
          res.render("users/login", {
            errorMessage: "Credenciales incorrectas.",
            captchaPhrase: req.session.captchaPhrase,
          });
        }
      });
    } else {
      res.render("users/login", {
        errorMessage: "Credenciales incorrectas.",
        captchaPhrase: req.session.captchaPhrase,
      });
    }
  });
});

// Cargar la configuración desde el archivo YAML
const emailConfig = (() => {
  try {
    const filePath = path.join(__dirname, "..", "config", "email.yml"); // Ruta actualizada
    const fileContents = fs.readFileSync(filePath, 'utf8');
    return yaml.load(fileContents);
  } catch (e) {
    console.error('Error al cargar la configuración:', e);
    return {}; // Retorna un objeto vacío en caso de error
  }
})();

// Configuración de Nodemailer
const transporter = nodemailer.createTransport({
  service: emailConfig.nodemailer.service,
  auth: {
    user: emailConfig.nodemailer.user,
    pass: emailConfig.nodemailer.pass,
  },
});

// Función para obtener un mensaje aleatorio del config
const getRandomTemplate = (emailConfig, resetLink) => {
  const templates = emailConfig.resetPasswordTemplates;
  const template = templates[Math.floor(Math.random() * templates.length)];
  return {
    subject: template.subject,
    text: template.message.replace('{link}', resetLink)
  };
};

// Ruta para solicitar el restablecimiento de contraseña
router.post("/password/forgot", (req, res) => {
  const { email } = req.body;

  // Verificar si el email existe en la base de datos
  db.query("SELECT id FROM usuarios WHERE email = ?", [email], (err, results) => {
    if (err) {
      console.error("Error al buscar el usuario:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "El correo electrónico no está registrado" });
    }

    const userId = results[0].id;

    // Generar un token aleatorio
    const token = crypto.randomBytes(32).toString('hex');
    const expiration = Date.now() + 3600000; // El token expira en 1 hora

    // Guardar el token y su fecha de expiración en la base de datos
    db.query(
      "INSERT INTO password_reset_tokens (user_id, token, expiration) VALUES (?, ?, ?)",
      [userId, token, expiration],
      (err) => {
        if (err) {
          console.error("Error al guardar el token:", err);
          return res.status(500).json({ error: "Error interno del servidor" });
        }

        // Construir el enlace de restablecimiento de contraseña
        const resetLink = `${emailConfig.resetPasswordBaseURL}/reset-password?token=${token}&id=${userId}`;
        const template = getRandomTemplate(emailConfig, resetLink);
        
        const mailOptions = {
          from: emailConfig.nodemailer.user,
          to: email,
          subject: template.subject,
          text: template.text,
        };

        transporter.sendMail(mailOptions, (err, info) => {
          if (err) {
            console.error("Error al enviar el correo:", err);
            return res.status(500).json({ error: "No se pudo enviar el correo electrónico" });
          }

          res.json({ success: true, message: "Correo de recuperación enviado" });
        });
      }
    );
  });
});

// Renderizar la página para solicitar la recuperación de contraseña
router.get("/password/forgot", (req, res) => {
  res.render("users/forgot-password", {
    title: "NakamaStream",
  });
});

// Renderizar la página para restablecer la contraseña
router.get("/reset-password", (req, res) => {
  const { token, id } = req.query;

  if (!token || !id) {
    return res.status(400).json({ error: "Token inválido o faltante" });
  }

  res.render("users/reset-password", {
    title: "NakamaStream",
    token,
    userId: id,
  });
});



// Ruta para restablecer la contraseña
router.post("/password/reset", (req, res) => {
  const { token, userId, newPassword } = req.body;

  // Verificar si el token es válido y no ha expirado
  db.query(
    "SELECT * FROM password_reset_tokens WHERE token = ? AND user_id = ? AND expiration > ?",
    [token, userId, Date.now()],
    (err, results) => {
      if (err) {
        console.error("Error al buscar el token:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      if (results.length === 0) {
        return res.status(400).json({ error: "Token inválido o expirado" });
      }

      // Si el token es válido, hashear la nueva contraseña
      bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
        if (err) {
          console.error("Error al encriptar la nueva contraseña:", err);
          return res.status(500).json({ error: "Error interno del servidor" });
        }

        // Actualizar la contraseña en la base de datos
        db.query(
          "UPDATE usuarios SET password = ? WHERE id = ?",
          [hashedPassword, userId],
          (err) => {
            if (err) {
              console.error("Error al actualizar la contraseña:", err);
              return res.status(500).json({ error: "Error al actualizar la contraseña" });
            }

            // Eliminar el token usado
            db.query(
              "DELETE FROM password_reset_tokens WHERE user_id = ?",
              [userId],
              (err) => {
                if (err) {
                  console.error("Error al eliminar el token:", err);
                }
                res.json({ success: true, message: "Contraseña actualizada correctamente" });
              }
            );
          }
        );
      });
    }
  );
});

router.post("/profile/update-password", (req, res) => {
  if (!req.session.loggedin) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const { currentPassword, newPassword } = req.body;
  const userId = req.session.userId;

  // Verify current password and update to new password
  db.query(
    "SELECT password FROM usuarios WHERE id = ?",
    [userId],
    (err, results) => {
      if (err) {
        console.error("Error al obtener la contraseña actual:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: "Usuario no encontrado" });
      }

      const currentPasswordHash = results[0].password;
      bcrypt.compare(currentPassword, currentPasswordHash, (err, match) => {
        if (err) {
          console.error("Error al verificar la contraseña actual:", err);
          return res
            .status(500)
            .json({ error: "Error al verificar la contraseña" });
        }

        if (!match) {
          return res
            .status(400)
            .json({ error: "La contraseña actual es incorrecta" });
        }

        // Hash the new password
        bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
          if (err) {
            console.error("Error al encriptar la nueva contraseña:", err);
            return res
              .status(500)
              .json({ error: "Error al actualizar la contraseña" });
          }

          // Update the password in the database
          db.query(
            "UPDATE usuarios SET password = ? WHERE id = ?",
            [hashedPassword, userId],
            (err, result) => {
              if (err) {
                console.error("Error al actualizar la contraseña:", err);
                return res
                  .status(500)
                  .json({ error: "Error al actualizar la contraseña" });
              }

              res.json({
                success: true,
                message: "Contraseña actualizada correctamente",
              });
            }
          );
        });
      });
    }
  );
});

// Ruta de cierre de sesión
router.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/");
})

// Ruta del perfil de usuario
router.get("/profile/:username", (req, res) => {
  if (!req.session.loggedin) {
    return res.redirect("/login");
  }

  const username = req.params.username;
  const isOwnProfile = req.session.username === username;

  // Función para censurar el email
  function censorEmail(email) {
    const [localPart, domain] = email.split('@');
    const censoredLocal = localPart.slice(0, 2) + '****'; // Muestra los primeros 2 caracteres y oculta el resto
    return `${censoredLocal}@${domain}`;
  }

  db.query(
    `SELECT u.id, u.username, u.email, u.created_at, u.banned, u.ban_expiration, 
            u.profile_image, u.banner_image, IFNULL(u.bio, '') as bio,
            TIMESTAMPDIFF(SECOND, u.created_at, NOW()) AS time_created,
            (SELECT COUNT(*) FROM favorites WHERE user_id = u.id) as favorite_count,
            (SELECT COUNT(*) FROM comments WHERE user_id = u.id) as comment_count, u.is_admin
     FROM usuarios u WHERE u.username = ?`,
    [username],
    (err, results) => {
      if (err) {
        console.error("Error al obtener información del usuario:", err);
        return res.status(500).send("Error al obtener información del usuario");
      }

      if (results.length === 0) {
        return res.status(404).send("Usuario no encontrado");
      }

      const user = results[0];
      const createdAtFormatted = moment(user.created_at).format(
        "DD/MM/YYYY HH:mm:ss"
      );
      const timeCreatedFormatted = moment
        .utc(user.time_created * 1000)
        .fromNow(); // Esto mostrará el tiempo en formato "hace X minutos"

      // Obtener el hash MD5 del correo electrónico para Gravatar
      const emailHash = crypto
        .createHash("md5")
        .update(user.email.trim().toLowerCase())
        .digest("hex");
      const gravatarUrl = `https://www.gravatar.com/avatar/${emailHash}`;

      let banExpirationFormatted = null;
      if (user.banned && user.ban_expiration > new Date()) {
        banExpirationFormatted = moment(user.ban_expiration).format(
          "DD/MM/YYYY HH:mm:ss"
        );
      }

      // Verificar si el usuario es administrador
      const isAdmin = user.is_admin === 1;

      // Obtener los animes favoritos del usuario
      db.query(
        `SELECT a.id, a.name, a.imageUrl, a.slug
         FROM animes a 
         JOIN favorites f ON a.id = f.anime_id 
         WHERE f.user_id = ?
         LIMIT 5`,
        [user.id],
        (err, favoriteAnimes) => {
          if (err) {
            console.error("Error al obtener animes favoritos:", err);
            return res.status(500).send("Error al obtener animes favoritos");
          }

          // Aplicar la censura del correo si no es el propio perfil del usuario
          const emailToShow = isOwnProfile ? user.email : censorEmail(user.email);

          res.render("users/profiles", {
            user: user,
            username: user.username,
            email: emailToShow, // Mostramos el email censurado si no es su perfil
            isAdmin: user.is_admin === 1,
            createdAtFormatted,
            timeCreatedFormatted,
            banned: user.banned,
            banExpirationFormatted,
            profileImageUrl:
              user.profile_image ||
              "https://avatars.githubusercontent.com/u/168317328?s=200&v=4",
            bannerImageUrl:
              user.banner_image ||
              "https://github.com/NakamaStream/Resources/blob/main/NakamaStream.png?raw=true",
            bio: user.bio,
            favoriteAnimes: favoriteAnimes,
            isOwnProfile: isOwnProfile,
          });
        }
      );
    }
  );
});

// Ruta para actualizar la información del usuario
router.post(
  "/profile/update-info",
  upload.fields([
    { name: "profileImage", maxCount: 1 },
    { name: "bannerImage", maxCount: 1 },
  ]),
  (req, res) => {
    if (!req.session.loggedin) {
      return res.status(401).json({ error: "No autorizado" });
    }

    //console.log("req.files:", req.files);
    //console.log("req.body:", req.body);

    const { newUsername, email, currentPassword, newPassword, bio } = req.body;
    const userId = req.session.userId;

    // Check if required fields are present
    if (!newUsername || !email) {
      return res
        .status(400)
        .json({ error: "Nombre de usuario y email son requeridos" });
    }

    // If currentPassword is not provided, we'll skip password verification
    // This allows users to update their profile without changing their password
    let updateFields = { username: newUsername, email: email };
    let updateValues = [newUsername, email];

    if (bio !== undefined) {
      updateFields.bio = bio;
      updateValues.push(bio);
    }

    if (req.files) {
      if (req.files["profileImage"] && req.files["profileImage"][0]) {
        updateFields.profile_image =
          "/uploads/" + req.files["profileImage"][0].filename;
        updateValues.push(updateFields.profile_image);
      }
      if (req.files["bannerImage"] && req.files["bannerImage"][0]) {
        updateFields.banner_image =
          "/uploads/" + req.files["bannerImage"][0].filename;
        updateValues.push(updateFields.banner_image);
      }
    }

    const updateUser = () => {
      updateValues.push(userId);
      const updateQuery = `UPDATE usuarios SET ${Object.keys(updateFields)
        .map((field) => `${field} = ?`)
        .join(", ")} WHERE id = ?`;

      db.query(updateQuery, updateValues, (err, results) => {
        if (err) {
          console.error("Error al actualizar la información del usuario:", err);
          return res
            .status(500)
            .json({ error: "Error al actualizar la información del usuario" });
        }

        req.session.username = newUsername;
        req.session.email = email;
        res.json({
          success: true,
          message: "Perfil actualizado correctamente",
        });
      });
    };

    if (currentPassword) {
      // If currentPassword is provided, verify it before updating
      db.query(
        "SELECT password FROM usuarios WHERE id = ?",
        [userId],
        (err, results) => {
          if (err) {
            console.error("Error al obtener la contraseña actual:", err);
            return res
              .status(500)
              .json({ error: "Error interno del servidor" });
          }

          if (results.length === 0) {
            return res.status(404).json({ error: "Usuario no encontrado" });
          }

          const currentPasswordHash = results[0].password;
          bcrypt.compare(currentPassword, currentPasswordHash, (err, match) => {
            if (err) {
              console.error("Error al verificar la contraseña actual:", err);
              return res
                .status(500)
                .json({ error: "Error al verificar la contraseña" });
            }

            if (!match) {
              return res
                .status(400)
                .json({ error: "La contraseña actual es incorrecta" });
            }

            if (newPassword) {
              bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
                if (err) {
                  console.error("Error al encriptar la nueva contraseña:", err);
                  return res
                    .status(500)
                    .json({ error: "Error al actualizar la contraseña" });
                }

                updateFields.password = hashedPassword;
                updateValues.push(hashedPassword);
                updateUser();
              });
            } else {
              updateUser();
            }
          });
        }
      );
    } else {
      // If currentPassword is not provided, update user without password verification
      updateUser();
    }
  }
);

// Ruta para actualizar la bio del usuario
router.post("/profile/update-bio", (req, res) => {
  if (!req.session.loggedin) {
    return res.status(401).json({ success: false, message: "No autorizado" });
  }

  const userId = req.session.userId;
  const { bio } = req.body;

  db.query(
    "UPDATE usuarios SET bio = ? WHERE id = ?",
    [bio, userId],
    (err, result) => {
      if (err) {
        console.error("Error al actualizar la bio:", err);
        return res
          .status(500)
          .json({ success: false, message: "Error al actualizar la bio" });
      }
      res.json({ success: true, message: "Bio actualizada correctamente" });
    }
  );
});

// Ruta para quitar el rol de administrador a un usuario
router.post("/admin/demote-user", (req, res) => {
  // Verificar si el usuario actual es administrador
  if (req.session.isAdmin) {
    const userId = req.body.userId;
    // Actualizar el usuario para quitarle el rol de administrador
    db.query(
      "UPDATE usuarios SET is_admin = ? WHERE id = ?",
      [false, userId],
      (err, result) => {
        if (err) {
          console.error(
            "Error al quitar el rol de administrador al usuario:",
            err
          );
          return res.redirect("/admin");
        }

        res.redirect("/admin");
      }
    );
  } else {
    // Si el usuario no es administrador, redirigir al dashboard
    res.redirect("/anime");
  }
});

module.exports = router;
