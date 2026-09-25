import { Response } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

const fail = (
  res: Response,
  status: number,
  msg: string
) =>
  res.status(status).json({
    success: false,
    error: msg,
    message: msg,
  });

// ==========================================
// PHOTO DE PROFIL
// ==========================================

export async function updateAvatar(
  req: AuthRequest,
  res: Response
) {
  try {
    if (!req.file) {
      return fail(res, 400, 'Aucune image reçue.');
    }

    const previous = await prisma.user.findUnique({
      where: {
        id: req.user!.id,
      },
      select: {
        avatar: true,
      },
    });

    const relativePath =
      `uploads/avatars/${req.file.filename}`;

    const user = await prisma.user.update({
      where: {
        id: req.user!.id,
      },
      data: {
        avatar: relativePath,
      },
    });

    // Supprime uniquement les anciennes images
    // stockées localement.
    if (
      previous?.avatar?.startsWith(
        'uploads/avatars/'
      )
    ) {
      fs.unlink(
        path.join(
          process.cwd(),
          previous.avatar
        ),
        () => {}
      );
    }

    const {
      password: _password,
      ...safeUser
    } = user;

    return res.json({
      success: true,
      user: safeUser,
    });
  } catch (err: any) {
    console.error(
      'Erreur updateAvatar:',
      err?.message || err
    );

    return fail(
      res,
      500,
      'Erreur serveur lors de la mise à jour de la photo.'
    );
  }
}

// ==========================================
// MES ANNONCES
// ==========================================

export async function getMyProducts(
  req: AuthRequest,
  res: Response
) {
  try {
    const products =
      await prisma.product.findMany({
        where: {
          sellerId: req.user!.id,
        },

        orderBy: {
          createdAt: 'desc',
        },

        select: {
          id: true,
          title: true,
          priceUSD: true,
          priceCDF: true,
          images: true,
          viewsCount: true,
          isSold: true,
          createdAt: true,
        },
      });

    const data = products.map((product) => ({
      ...product,
      views: product.viewsCount,
      status: product.isSold
        ? 'SOLD'
        : 'AVAILABLE',
    }));

    return res.json({
      success: true,
      data,
    });
  } catch (err: any) {
    console.error(
      'Erreur getMyProducts:',
      err?.message || err
    );

    return fail(
      res,
      500,
      'Erreur serveur lors du chargement de vos annonces.'
    );
  }
}

// ==========================================
// MARQUER UNE ANNONCE COMME VENDUE
// ==========================================

export async function markProductSold(
  req: AuthRequest,
  res: Response
) {
  try {
    const id = String(req.params.id);

    if (!id) {
      return fail(
        res,
        400,
        'ID du produit requis.'
      );
    }

    const product =
      await prisma.product.findUnique({
        where: { id },
        select: {
          sellerId: true,
        },
      });

    if (!product) {
      return fail(
        res,
        404,
        'Annonce introuvable.'
      );
    }

    if (
      product.sellerId !== req.user!.id
    ) {
      return fail(
        res,
        403,
        "Cette annonce ne vous appartient pas."
      );
    }

    const updated =
      await prisma.product.update({
        where: { id },
        data: {
          isSold: true,
        },
      });

    return res.json({
      success: true,
      data: {
        ...updated,
        status: 'SOLD',
      },
    });
  } catch (err: any) {
    console.error(
      'Erreur markProductSold:',
      err?.message || err
    );

    return fail(
      res,
      500,
      'Erreur serveur.'
    );
  }
}

// ==========================================
// SUPPRIMER UNE ANNONCE
// ==========================================

export async function deleteProduct(
  req: AuthRequest,
  res: Response
) {
  try {
    const id = String(req.params.id);

    if (!id) {
      return fail(
        res,
        400,
        'ID du produit requis.'
      );
    }

    const product =
      await prisma.product.findUnique({
        where: { id },
        select: {
          sellerId: true,
        },
      });

    if (!product) {
      return fail(
        res,
        404,
        'Annonce introuvable.'
      );
    }

    if (
      product.sellerId !== req.user!.id
    ) {
      return fail(
        res,
        403,
        "Cette annonce ne vous appartient pas."
      );
    }

    await prisma.product.delete({
      where: { id },
    });

    return res.json({
      success: true,
    });
  } catch (err: any) {
    console.error(
      'Erreur deleteProduct:',
      err?.message || err
    );

    return fail(
      res,
      500,
      'Erreur serveur lors de la suppression.'
    );
  }
}

// ==========================================
// STATISTIQUES
// ==========================================

export async function getStats(
  req: AuthRequest,
  res: Response
) {
  try {
    const products =
      await prisma.product.findMany({
        where: {
          sellerId: req.user!.id,
        },

        select: {
          viewsCount: true,
          isSold: true,
        },
      });

    const totalViews =
      products.reduce(
        (sum, product) =>
          sum + product.viewsCount,
        0
      );

    const activeCount =
      products.filter(
        (product) => !product.isSold
      ).length;

    const soldCount =
      products.length - activeCount;

    return res.json({
      success: true,
      data: {
        totalViews,
        activeCount,
        soldCount,
      },
    });
  } catch (err: any) {
    console.error(
      'Erreur getStats:',
      err?.message || err
    );

    return fail(
      res,
      500,
      'Erreur serveur.'
    );
  }
}
