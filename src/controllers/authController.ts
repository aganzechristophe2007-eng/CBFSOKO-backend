import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { AuthRequest, JWT_SECRET } from '../middleware/auth.middleware';

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
          phone: phone ? phone.trim() : null 
        },
      });
      
      await tx.wallet.create({ data: { userId: newUser.id } });
      return newUser;
    });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
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
    let user = await prisma.user.findUnique({ 
      where: { email: cleanEmail },
      include: { wallet: true }
    });

    // 2. SI LE COMPTE N'EXISTE PAS -> CRÉATION AUTOMATIQUE INTELLIGENTE (Expérience 1M+ utilisateurs)
    if (!user) {
      if (password.length < 8) {
        return res.status(400).json({ 
          message: 'Ce compte n\'existe pas. Entrez un mot de passe d\'au moins 8 caractères pour le créer instantanément.' 
        });
      }

      const hashed = await bcrypt.hash(password, 12);
      const defaultName = cleanEmail.split('@')[0];

      user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            name: defaultName.charAt(0).toUpperCase() + defaultName.slice(1),
            email: cleanEmail,
            password: hashed,
          },
        });

        await tx.wallet.create({ data: { userId: newUser.id } });
        
        return await tx.user.findUnique({
          where: { id: newUser.id },
          include: { wallet: true }
        });
      });

      console.log(`✨ Nouveau compte créé à la volée pour : ${cleanEmail}`);
    } else {
      // 3. SI LE COMPTE EXISTE -> VÉRIFICATION DU MOT DE PASSE
      const valid = await bcrypt.compare(password, user!.password);
      if (!valid) {
        return res.status(401).json({ message: 'Identifiants invalides' });
      }
    }

    // 4. GÉNÉRATION DU TOKEN JWT ET RETOUR DE LA SESSION SÉCURISÉE
    const token = jwt.sign({ id: user!.id }, JWT_SECRET, { expiresIn: '30d' });
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