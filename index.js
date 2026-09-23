const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { MercadoPagoConfig, Preference } = require('mercadopago');

const mercadopago = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN_TEST
});

async function enviarEmailConfirmacion(pedido) {
  try {
    let itemsHtml = '';
    const items = typeof pedido.items === 'string' ? JSON.parse(pedido.items) : pedido.items;
    items.forEach(it => {
      const nombre = it.nombre || it.name || 'Producto';
      const cantidad = it.cantidad || it.quantity || 1;
      itemsHtml += `<li>${cantidad} x ${nombre}</li>`;
    });

      await resend.emails.send({  
      from: 'Pañalera Arcoiris <pedidos@parcoiris.com.ar>',
      to: pedido.cliente_email,
      subject: `Confirmación de tu pedido - ${pedido.numero_seguimiento}`,
      html: `
        <h2>¡Gracias por tu compra, ${pedido.cliente_nombre}!</h2>
        <p>Tu pedido fue registrado con éxito.</p>
        <p><strong>Número de seguimiento:</strong> ${pedido.numero_seguimiento}</p>
        <p><strong>Productos:</strong></p>
        <ul>${itemsHtml}</ul>
        <p><strong>Total:</strong> $${Number(pedido.total).toLocaleString('es-AR')}</p>
        <p><strong>Dirección de entrega:</strong> ${pedido.direccion}${pedido.localidad ? ', ' + pedido.localidad : ''}</p>
        <p>Guardá este número para hacer seguimiento de tu pedido en nuestro sitio.</p>
        <p>¡Gracias por elegirnos!</p>
      `
    });
    console.log('Email de confirmación enviado a', pedido.cliente_email);
  } catch (error) {
    console.error('Error al enviar email:', error.message);
  }
}

const app = express();
app.use(express.static(__dirname));
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Backend de Pañalera Arcoiris funcionando');
});

// Trae productos con su stock actual calculado
app.get('/api/productos', async (req, res) => {
  try {
    const { buscar } = req.query;
    let query = `
      SELECT p.*, 
        COALESCE(SUM(
          CASE WHEN m.tipo = 'venta' THEN -m.cantidad ELSE m.cantidad END
        ), 0) AS stock
      FROM productos p
      LEFT JOIN movimientos_stock m ON m.producto_id = p.id
    `;
    const params = [];

    if (buscar) {
      query += ` WHERE p.nombre ILIKE $1 OR p.codigo_barras = $2 `;
      params.push(`%${buscar}%`, buscar);
    }

    query += ` GROUP BY p.id ORDER BY p.nombre LIMIT 50`;

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// Trae el stock actual de un solo producto
app.get('/api/productos/:id/stock', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query(
      `SELECT COALESCE(SUM(
         CASE WHEN tipo = 'venta' THEN -cantidad ELSE cantidad END
       ), 0) AS stock
       FROM movimientos_stock WHERE producto_id = $1`,
      [id]
    );
    res.json({ producto_id: Number(id), stock: Number(resultado.rows[0].stock) });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener stock' });
  }
});

// Trae el mapeo id_web -> precio y stock real (para el e-commerce)
app.get('/api/productos-web', async (req, res) => {
  try {
    const query = `
      SELECT 
        pw.id_web,
        p.precio,
        COALESCE(SUM(
          CASE WHEN m.tipo = 'venta' THEN -m.cantidad ELSE m.cantidad END
        ), 0) AS stock
      FROM productos_web pw
      JOIN productos p ON p.id = pw.producto_id
      LEFT JOIN movimientos_stock m ON m.producto_id = p.id
      GROUP BY pw.id_web, p.precio
    `;
    const resultado = await pool.query(query);
    res.json(resultado.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener productos web' });
  }
});

// Trae categorias y marcas para los desplegables del formulario
app.get('/api/categorias', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT id, nombre FROM categorias ORDER BY nombre');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener categorias' });
  }
});

app.get('/api/marcas', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT id, nombre FROM marcas ORDER BY nombre');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener marcas' });
  }
});

// Trae el stock de todos los productos, con filtros opcionales por categoria y marca
app.get('/api/stock', async (req, res) => {
  const { categoria_id, marca_id } = req.query;

  try {
    let query = `
      SELECT 
        p.id,
        p.nombre,
        m.nombre AS marca,
        c.nombre AS categoria,
        COALESCE(SUM(
          CASE WHEN ms.tipo = 'venta' THEN -ms.cantidad ELSE ms.cantidad END
        ), 0) AS stock
      FROM productos p
      LEFT JOIN marcas m ON p.marca_id = m.id
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN movimientos_stock ms ON ms.producto_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (categoria_id) {
      params.push(categoria_id);
      query += ` AND p.categoria_id = $${params.length}`;
    }
    if (marca_id) {
      params.push(marca_id);
      query += ` AND p.marca_id = $${params.length}`;
    }

    query += `
      GROUP BY p.id, p.nombre, m.nombre, c.nombre
      ORDER BY c.nombre, m.nombre, p.nombre
    `;

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener el stock' });
  }
});

// Crea un producto nuevo
app.post('/api/productos', async (req, res) => {
  const { nombre, codigo_barras, precio, marca_id, categoria_id } = req.body;

  if (!nombre || !precio) {
    return res.status(400).json({ error: 'Faltan datos: nombre y precio son obligatorios' });
  }

  try {
    const resultado = await pool.query(
      `INSERT INTO productos (nombre, codigo_barras, precio, marca_id, categoria_id, fecha_creacion)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [nombre, codigo_barras || null, precio, marca_id || null, categoria_id || null]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al crear el producto' });
  }
});

// Actualizar precio de un producto: si pertenece a una línea (marca_id + linea_id),
// actualiza todos los talles hermanos al mismo precio, excepto Talle P y Talle RN
// que siempre manejan precio propio.
app.patch('/api/productos/:id/precio', async (req, res) => {
  const { id } = req.params;
  const { precio } = req.body;

  if (precio === undefined || isNaN(precio) || precio < 0) {
    return res.status(400).json({ error: 'Precio inválido' });
  }

  try {
    const productoActual = await pool.query(
      'SELECT id, nombre, marca_id, linea_id FROM productos WHERE id = $1',
      [id]
    );
    if (productoActual.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const { nombre, marca_id, linea_id } = productoActual.rows[0];

    // Talle P o RN: siempre precio propio, nunca se agrupa
    const esTalleIndependiente = /talle\s+p(\s|$)/i.test(nombre) || /talle\s+rn/i.test(nombre);

    let result;
    if (esTalleIndependiente || !linea_id) {
      result = await pool.query(
        'UPDATE productos SET precio = $1 WHERE id = $2 RETURNING *',
        [precio, id]
      );
    } else {
      result = await pool.query(
        `UPDATE productos
         SET precio = $1
         WHERE marca_id = $2
           AND linea_id = $3
           AND nombre !~* 'talle\\s+p(\\s|$)'
           AND nombre !~* 'talle\\s+rn'
         RETURNING *`,
        [precio, marca_id, linea_id]
      );
    }

    res.json({ actualizados: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar precio' });
  }
});

// Historial de ventas de las últimas 24 horas
app.get('/api/movimientos/hoy', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.id, m.cantidad, m.fecha, m.metodo_pago, m.nota, m.venta_id, p.nombre, p.precio,
             (m.cantidad * p.precio) AS subtotal
      FROM movimientos_stock m
      JOIN productos p ON p.id = m.producto_id
      WHERE m.tipo = 'venta'
        AND m.canal = 'local'
        AND m.fecha >= NOW() - INTERVAL '24 hours'
      ORDER BY m.fecha DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al traer historial' });
  }
});

// Actualiza el codigo de barras de un producto ya existente
app.patch('/api/productos/:id/codigo-barras', async (req, res) => {
  const { id } = req.params;
  const { codigo_barras } = req.body;

  if (!codigo_barras) {
    return res.status(400).json({ error: 'Falta el codigo de barras' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE productos SET codigo_barras = $1 WHERE id = $2 RETURNING *`,
      [codigo_barras, id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(resultado.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al actualizar el codigo de barras' });
  }
});

// Registra una venta: descuenta stock de forma atómica, no permite stock negativo
app.post('/api/ventas', async (req, res) => {
  const { producto_id, canal, cantidad, nota, metodo_pago, venta_id } = req.body;

  if (!producto_id || !canal || !cantidad || cantidad <= 0) {
    return res.status(400).json({ error: 'Faltan datos o cantidad inválida' });
  }
  if (!['local', 'web'].includes(canal)) {
    return res.status(400).json({ error: 'Canal inválido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const productoResult = await client.query(
      `SELECT id FROM productos WHERE id = $1 FOR UPDATE`,
      [producto_id]
    );
    if (productoResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const stockResult = await client.query(
      `SELECT COALESCE(SUM(
         CASE WHEN tipo = 'venta' THEN -cantidad ELSE cantidad END
       ), 0) AS stock
       FROM movimientos_stock WHERE producto_id = $1`,
      [producto_id]
    );
    const stockActual = Number(stockResult.rows[0].stock);

    if (stockActual < cantidad) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Stock insuficiente', stock_disponible: stockActual });
    }

    const insertResult = await client.query(
      `INSERT INTO movimientos_stock (producto_id, canal, tipo, cantidad, fecha, nota, metodo_pago, venta_id)
       VALUES ($1, $2, 'venta', $3, NOW(), $4, $5, $6) RETURNING *`,
      [producto_id, canal, cantidad, nota || null, metodo_pago || null, venta_id || null]
    );

    await client.query('COMMIT');
    res.status(201).json(insertResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error.message);
    res.status(500).json({ error: 'Error al registrar la venta' });
  } finally {
    client.release();
  }
});

// Registra ingreso, ajuste o devolución (suma o resta stock según el caso)
app.post('/api/movimientos', async (req, res) => {
  const { producto_id, canal, tipo, cantidad, nota } = req.body;

  if (!producto_id || !canal || !tipo || cantidad === undefined) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  if (!['ingreso', 'ajuste', 'devolucion'].includes(tipo)) {
    return res.status(400).json({ error: 'Para ventas usá /api/ventas' });
  }

  try {
    const resultado = await pool.query(
      `INSERT INTO movimientos_stock (producto_id, canal, tipo, cantidad, fecha, nota)
       VALUES ($1, $2, $3, $4, NOW(), $5) RETURNING *`,
      [producto_id, canal, tipo, cantidad, nota || null]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al registrar el movimiento' });
  }
});

// Crea un pedido nuevo (lo llama el checkout de la pagina web)
// Descuenta stock de forma atómica por cada producto, igual que /api/ventas.
// Si algún producto no tiene stock suficiente, se cancela todo el pedido.
app.post('/api/pedidos', async (req, res) => {
  const {
    cliente_nombre,
    cliente_telefono,
    cliente_email,
    direccion,
    localidad,
    codigo_postal,
    items,
    total,
    metodo_pago
  } = req.body;

  if (!cliente_nombre || !direccion || !items || !total) {
    return res.status(400).json({ error: 'Faltan datos obligatorios del pedido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Para cada item del carrito, traducir id_web -> producto_id real,
    //    bloquear la fila del producto, chequear stock y descontar.
    for (const item of items) {
      const idWeb = item.id;
      const cantidad = Number(item.cantidad);

      const pwResult = await client.query(
        `SELECT pw.producto_id
         FROM productos_web pw
         JOIN productos p ON p.id = pw.producto_id
         WHERE pw.id_web = $1
         FOR UPDATE OF p`,
        [idWeb]
      );

      if (pwResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Producto no encontrado: ${idWeb}` });
      }

      const productoId = pwResult.rows[0].producto_id;

      const stockResult = await client.query(
        `SELECT COALESCE(SUM(
           CASE WHEN tipo = 'venta' THEN -cantidad ELSE cantidad END
         ), 0) AS stock
         FROM movimientos_stock WHERE producto_id = $1`,
        [productoId]
      );
      const stockActual = Number(stockResult.rows[0].stock);

      if (stockActual < cantidad) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Sin stock suficiente para "${item.nombre}"`,
          stock_disponible: stockActual
        });
      }

      await client.query(
        `INSERT INTO movimientos_stock (producto_id, canal, tipo, cantidad, fecha, nota)
         VALUES ($1, 'web', 'venta', $2, NOW(), $3)`,
        [productoId, cantidad, `Pedido web - ${item.nombre}`]
      );
    }

    // 2. Ya descontado el stock de todos los items, crear el pedido.
    const numero_seguimiento = 'P' + Date.now().toString(36).toUpperCase().slice(-6);
    const resultado = await client.query(
      `INSERT INTO pedidos
        (cliente_nombre, cliente_telefono, cliente_email, direccion, localidad, codigo_postal, items, total, metodo_pago, estado, numero_seguimiento, fecha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pendiente', $10, NOW())
       RETURNING *`,
      [cliente_nombre, cliente_telefono || null, cliente_email || null, direccion, localidad || null, codigo_postal || null, JSON.stringify(items), total, metodo_pago || null, numero_seguimiento]
    );

    await client.query('COMMIT');

    const pedidoCreado = resultado.rows[0];

    if (pedidoCreado.cliente_email) {
      enviarEmailConfirmacion(pedidoCreado);
    }

    res.status(201).json(pedidoCreado);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error.message);
    res.status(500).json({ error: 'Error al crear el pedido' });
  } finally {
    client.release();
  }
});
// Lista todos los pedidos (para el panel de administracion y para "Mis Pedidos" del cliente)
app.get('/api/pedidos', async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT * FROM pedidos ORDER BY fecha DESC`
    );
    res.json(resultado.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// Cambia el estado de un pedido (lo usa el panel de administracion, nunca el cliente)
app.patch('/api/pedidos/:id/estado', async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;

  const estadosValidos = ['pendiente', 'preparando', 'en_camino', 'entregado'];
  if (!estadosValidos.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE pedidos SET estado = $1 WHERE id = $2 RETURNING *`,
      [estado, id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    res.json(resultado.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al actualizar el estado del pedido' });
  }
});

// Crea una preferencia de pago en Mercado Pago (checkout con tarjeta)
app.post('/api/crear-preferencia', async (req, res) => {
  const { items, cliente_email } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Faltan items para crear la preferencia' });
  }

  try {
    const preferenceItems = items.map(item => ({
      title: item.nombre,
      quantity: Number(item.cantidad),
      unit_price: Number(item.precio),
      currency_id: 'ARS'
    }));

    const preference = new Preference(mercadopago);

    const resultado = await preference.create({
      body: {
        items: preferenceItems,
        payer: cliente_email ? { email: cliente_email } : undefined,
        back_urls: {
          success: 'https://parcoiris.com.ar',
          failure: 'https://parcoiris.com.ar',
          pending: 'https://parcoiris.com.ar'
        },
        auto_return: 'approved'
      }
    });

    res.status(201).json({
      preference_id: resultado.id,
      init_point: resultado.init_point,
      sandbox_init_point: resultado.sandbox_init_point
    });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al crear la preferencia de pago' });
  }
});

// Dirección fija del local
const ORIGEN_DIRECCION = 'Hipólito Irigoyen 520, Manuel Alberti, Pilar, Buenos Aires, Argentina';

async function calcularDistanciaKm(direccionDestino) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(ORIGEN_DIRECCION)}&destinations=${encodeURIComponent(direccionDestino)}&units=metric&key=${process.env.GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log('Respuesta de Google:', JSON.stringify(data));

  if (data.status !== 'OK') {
    throw new Error('Error al calcular la distancia: ' + data.status + ' - ' + (data.error_message || ''));
  }
  const elemento = data.rows[0]?.elements[0];
  if (!elemento || elemento.status !== 'OK') {
    throw new Error('No se pudo encontrar esa dirección o no hay ruta disponible: ' + (elemento?.status || 'sin datos'));
  }
  return elemento.distance.value / 1000;
}

function calcularCostoEnvio(distanciaKm, montoCompra) {
  if (distanciaKm <= 5) {
    return montoCompra >= 50000 ? { costo: 0, mensaje: 'Envío gratis' } : { costo: 2000, mensaje: null };
  }
  if (distanciaKm <= 10) {
    return montoCompra >= 70000 ? { costo: 0, mensaje: 'Envío gratis' } : { costo: 4000, mensaje: null };
  }
  if (distanciaKm <= 15) {
    return montoCompra >= 110000 ? { costo: 0, mensaje: 'Envío gratis' } : { costo: 6000, mensaje: null };
  }
  if (distanciaKm <= 25) {
    return montoCompra >= 180000 ? { costo: 0, mensaje: 'Envío gratis' } : { costo: 12000, mensaje: null };
  }
  return { costo: null, mensaje: 'Envío a cotizar por WhatsApp' };
}

app.post('/api/calcular-envio', async (req, res) => {
  const { direccion, montoCompra } = req.body;
  if (!direccion) {
    return res.status(400).json({ error: 'Falta la dirección' });
  }
  try {
    const distanciaKm = await calcularDistanciaKm(direccion);
    const resultado = calcularCostoEnvio(distanciaKm, Number(montoCompra) || 0);
    res.json({
      distancia_km: Math.round(distanciaKm * 10) / 10,
      costo_envio: resultado.costo,
      mensaje: resultado.mensaje
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'No se pudo calcular el envío. Revisá la dirección ingresada.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
