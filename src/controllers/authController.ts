import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { AuthRequest, JWT_SECRET } from '../middleware/auth.middleware';

const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // doit correspondre à expiresIn: '30d' du JWT

// Hash factice pour comparer en durée constante quand l'email n'existe pas (anti timing attack)
const DUMMY_HASH = bcrypt.hashSync('mot-de-passe-factice-anti-timing', 12);

// Pose le cookie de session lu par socket.service.ts (io.use -> handshake.headers.cookie ->
// parsed.token) pour authentifier la connexion websocket. Sans ce cookie, aucun socket ne
// s'authentifie jamais : ni les messages en temps réel, ni la signalisation d'appel ne
// fonctionnent, même si les routes REST classiques marchent via le token renvoyé en JSON.
function setAuthCookie(res: Response, token: string) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: true, // obligatoire en production : frontend (Vercel) et backend (Render) sont sur des domaines différents
    sameSite: 'none', // obligatoire pour qu'un cookie cross-domain soit envoyé par le navigateur
    maxAge: TOKEN_MAX_AGE_MS,
  });
}

export async function register(req: AuthRequest, res: Response) {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Nom, email et mot de passe requis' });
    }

    const cleanEmail = email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé' });
    }

    const hashed = await bcrypt.hash(password, 12); // Sécurité renforcée à 12 rounds

    // Utilisation d'une transaction Prisma pour garantir la création simultanée de l'utilisateur et de son wallet
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          name: name.trim(),
          email: cleanEmail,
          password: hashed,
          phone: phone ? phone.trim() : null,
        },
      });

      await tx.wallet.create({ data: { userId: newUser.id } });
      return newUser;
    });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    setAuthCookie(res, token);
    const { password: _pw, ...safeUser } = user;

    return res.status(201).json({ token, data: safeUser });
  } catch (err) {
    console.error('Erreur register:', err);
    return res.status(500).json({ message: 'Erreur serveur lors de l\'inscription' });
  }
}

export async function login(req: AuthRequest, res: Response) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email et mot de passe requis' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // 1. VÉRIFICATION RÉELLE DANS LA BASE DE DONNÉES
    const user = await prisma.user.findUnique({
      where: { email: cleanEmail },
      include: { wallet: true }
    });

    // 2. Aucune création automatique de compte : l'inscription passe uniquement par register().
    // On compare toujours un hash (même durée que l'email existe ou non) avec un message identique.
    const valid = await bcrypt.compare(String(password), user?.password ?? DUMMY_HASH);
    if (!user || !valid) {
      return res.status(401).json({ message: 'Identifiants invalides' });
    }

    // 4. GÉNÉRATION DU TOKEN JWT, POSE DU COOKIE DE SESSION ET RETOUR DE LA SESSION SÉCURISÉE
    const token = jwt.sign({ id: user!.id }, JWT_SECRET, { expiresIn: '30d' });
    setAuthCookie(res, token);
    const { password: _pw, ...safeUser } = user!;

    return res.json({ token, data: safeUser });
  } catch (err) {
    console.error('Erreur login:', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la connexion' });
  }
}

export async function me(req: AuthRequest, res: Response) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { shop: true, wallet: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable' });
    }

    const { password: _pw, ...safeUser } = user;
    return res.json({ data: safeUser });
  } catch (err) {
    console.error('Erreur me:', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}