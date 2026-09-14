import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.event.*;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Cliente de escritorio (Java/Swing) para las ventanillas del Sistema de
 * Venta de Entradas - Entrada de la Virgen de Guadalupe.
 *
 * Consume la MISMA API REST que la interfaz web (Node.js), de modo que
 * ambos clientes (navegador y escritorio) comparten reglas de negocio,
 * base de datos e inventario en tiempo real.
 *
 * Compilar:  javac -d out src/Main.java
 * Ejecutar:  java -cp out Main [http://localhost:3000]
 */
public class Main extends JFrame {

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();
    private String baseUrl;
    private String token;
    private String ventanilla, distrito;

    // Estado de la venta en curso
    private Integer sectorSeleccionadoId = null;
    private double sectorSeleccionadoPrecio = 0;
    private String sectorSeleccionadoNombre = "";
    private boolean puestoReservado = false;

    // Componentes
    private JTextField txtUsuario, txtCi, txtNombre, txtTelefono, txtPuesto;
    private JPasswordField txtPassword;
    private JLabel lblCiEstado, lblSesion, lblResumen;
    private JCheckBox chkCedula, chkLuz, chkImpuestos;
    private JPanel panelSectores;
    private JButton btnVender;
    private CardLayout cards;
    private JPanel root;
    private boolean compradorValido = false;

    public Main(String baseUrl) {
        super("Venta de Entradas — Entrada Virgen de Guadalupe (Cliente Java)");
        this.baseUrl = baseUrl;
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setSize(950, 650);
        setLocationRelativeTo(null);

        cards = new CardLayout();
        root = new JPanel(cards);
        root.add(buildLoginPanel(), "login");
        root.add(buildVentaPanel(), "venta");
        add(root);
        cards.show(root, "login");
    }

    // -------------------------------------------------------------------
    // LOGIN
    // -------------------------------------------------------------------
    private JPanel buildLoginPanel() {
        JPanel p = new JPanel(new GridBagLayout());
        JPanel box = new JPanel();
        box.setLayout(new BoxLayout(box, BoxLayout.Y_AXIS));
        box.setBorder(new EmptyBorder(20, 20, 20, 20));
        box.setPreferredSize(new Dimension(320, 220));

        JLabel title = new JLabel("Ingreso de Cajero / Ventanilla");
        title.setFont(title.getFont().deriveFont(Font.BOLD, 15f));
        box.add(title);
        box.add(Box.createVerticalStrut(10));

        box.add(new JLabel("Usuario"));
        txtUsuario = new JTextField("cajero1");
        box.add(txtUsuario);
        box.add(Box.createVerticalStrut(8));

        box.add(new JLabel("Contraseña"));
        txtPassword = new JPasswordField("1234");
        box.add(txtPassword);
        box.add(Box.createVerticalStrut(12));

        JButton btnLogin = new JButton("Iniciar sesión");
        btnLogin.addActionListener(e -> doLogin());
        box.add(btnLogin);

        box.add(Box.createVerticalStrut(10));
        JLabel hint = new JLabel("<html><small>Demo: cajero1/cajero2/cajero3 — clave: 1234<br>Servidor: " + baseUrl + "</small></html>");
        box.add(hint);

        p.add(box);
        return p;
    }

    private void doLogin() {
        try {
            String usuario = txtUsuario.getText().trim();
            String password = new String(txtPassword.getPassword());
            String json = String.format("{\"usuario\":\"%s\",\"password\":\"%s\"}",
                    esc(usuario), esc(password));
            HttpResponse<String> resp = post("/api/auth/login", json, null);
            if (resp.statusCode() != 200) {
                JOptionPane.showMessageDialog(this, extraerCampo(resp.body(), "error"), "Error", JOptionPane.ERROR_MESSAGE);
                return;
            }
            token = extraerCampo(resp.body(), "token");
            ventanilla = extraerCampo(resp.body(), "ventanilla");
            distrito = extraerCampo(resp.body(), "distrito");
            lblSesion.setText("Ventanilla " + ventanilla + " · " + distrito);
            cargarSectores();
            cards.show(root, "venta");
        } catch (Exception ex) {
            JOptionPane.showMessageDialog(this, "No se pudo conectar con el servidor:\n" + ex.getMessage(),
                    "Error de conexión", JOptionPane.ERROR_MESSAGE);
        }
    }

    // -------------------------------------------------------------------
    // VENTA
    // -------------------------------------------------------------------
    private JPanel buildVentaPanel() {
        JPanel main = new JPanel(new BorderLayout());

        JPanel top = new JPanel(new BorderLayout());
        top.setBackground(new Color(140, 47, 47));
        top.setBorder(new EmptyBorder(10, 15, 10, 15));
        JLabel titulo = new JLabel("Entrada de la Virgen de Guadalupe — Venta de Entradas");
        titulo.setForeground(Color.WHITE);
        titulo.setFont(titulo.getFont().deriveFont(Font.BOLD, 14f));
        lblSesion = new JLabel("");
        lblSesion.setForeground(Color.WHITE);
        top.add(titulo, BorderLayout.WEST);
        top.add(lblSesion, BorderLayout.EAST);
        main.add(top, BorderLayout.NORTH);

        JPanel cols = new JPanel(new GridLayout(1, 3, 10, 10));
        cols.setBorder(new EmptyBorder(10, 10, 10, 10));

        // Columna 1: comprador
        JPanel c1 = titledPanel("1. Datos del comprador");
        c1.setLayout(new BoxLayout(c1, BoxLayout.Y_AXIS));
        c1.add(new JLabel("Cédula de Identidad"));
        JPanel ciRow = new JPanel(new BorderLayout(5, 0));
        txtCi = new JTextField();
        JButton btnBuscar = new JButton("Buscar");
        ciRow.add(txtCi, BorderLayout.CENTER);
        ciRow.add(btnBuscar, BorderLayout.EAST);
        c1.add(ciRow);
        lblCiEstado = new JLabel(" ");
        c1.add(lblCiEstado);
        c1.add(Box.createVerticalStrut(8));
        c1.add(new JLabel("Nombre completo"));
        txtNombre = new JTextField();
        c1.add(txtNombre);
        c1.add(Box.createVerticalStrut(8));
        c1.add(new JLabel("Teléfono (opcional)"));
        txtTelefono = new JTextField();
        c1.add(txtTelefono);
        c1.add(Box.createVerticalStrut(12));
        c1.add(new JLabel("Checklist de documentación obligatoria:"));
        chkCedula = new JCheckBox("Cédula de Identidad (Original)");
        chkLuz = new JCheckBox("Factura de servicio de Luz");
        chkImpuestos = new JCheckBox("Comprobante de Impuestos del Inmueble");
        c1.add(chkCedula); c1.add(chkLuz); c1.add(chkImpuestos);
        btnBuscar.addActionListener(e -> buscarCi());

        // Columna 2: sectores
        JPanel c2 = titledPanel("2. Sector y puesto");
        c2.setLayout(new BorderLayout());
        panelSectores = new JPanel(new GridLayout(0, 2, 5, 5));
        JScrollPane scroll = new JScrollPane(panelSectores);
        c2.add(scroll, BorderLayout.CENTER);
        JPanel puestoRow = new JPanel(new BorderLayout(5, 0));
        txtPuesto = new JTextField();
        JButton btnReservar = new JButton("Reservar (5 min)");
        puestoRow.add(new JLabel("Puesto:"), BorderLayout.WEST);
        puestoRow.add(txtPuesto, BorderLayout.CENTER);
        puestoRow.add(btnReservar, BorderLayout.EAST);
        c2.add(puestoRow, BorderLayout.SOUTH);
        btnReservar.addActionListener(e -> reservarPuesto());

        // Columna 3: resumen y venta
        JPanel c3 = titledPanel("3. Confirmar venta");
        c3.setLayout(new BorderLayout());
        lblResumen = new JLabel("<html>Seleccione sector y puesto.</html>");
        lblResumen.setVerticalAlignment(SwingConstants.TOP);
        c3.add(lblResumen, BorderLayout.CENTER);
        btnVender = new JButton("Registrar venta e imprimir");
        btnVender.setBackground(new Color(140, 47, 47));
        btnVender.setForeground(Color.WHITE);
        btnVender.addActionListener(e -> registrarVenta());
        c3.add(btnVender, BorderLayout.SOUTH);

        cols.add(c1); cols.add(c2); cols.add(c3);
        main.add(cols, BorderLayout.CENTER);
        return main;
    }

    private JPanel titledPanel(String titulo) {
        JPanel p = new JPanel();
        p.setBorder(BorderFactory.createTitledBorder(titulo));
        return p;
    }

    private void cargarSectores() {
        try {
            HttpResponse<String> resp = get("/api/sectores");
            panelSectores.removeAll();
            List<Map<String, String>> sectores = parseArrayOfObjects(resp.body());
            for (Map<String, String> s : sectores) {
                String nombre = s.get("nombre");
                String precio = s.get("precio");
                String disponibles = s.get("disponibles");
                int id = Integer.parseInt(s.get("id"));
                JButton b = new JButton("<html><b>" + nombre + "</b><br>Bs " + precio + " · " + disponibles + " disp.</html>");
                b.setBackground(colorFromHex(s.get("color")));
                b.setOpaque(true);
                b.addActionListener(e -> {
                    sectorSeleccionadoId = id;
                    sectorSeleccionadoPrecio = Double.parseDouble(precio);
                    sectorSeleccionadoNombre = nombre;
                    puestoReservado = false;
                    actualizarResumen();
                });
                panelSectores.add(b);
            }
            panelSectores.revalidate();
            panelSectores.repaint();
        } catch (Exception ex) {
            JOptionPane.showMessageDialog(this, "Error al cargar sectores: " + ex.getMessage());
        }
    }

    private Color colorFromHex(String hex) {
        try { return Color.decode(hex); } catch (Exception e) { return Color.LIGHT_GRAY; }
    }

    private void buscarCi() {
        try {
            String ci = txtCi.getText().trim();
            HttpResponse<String> resp = get("/api/compradores/" + ci);
            String cantidad = extraerCampoNumero(resp.body(), "cantidad");
            String puedeComprar = extraerCampo(resp.body(), "puedeComprar");
            compradorValido = "true".equals(puedeComprar);
            if (compradorValido) {
                lblCiEstado.setText("<html><font color='green'>✔ C.I. habilitada (" + cantidad + "/2 entradas)</font></html>");
            } else {
                lblCiEstado.setText("<html><font color='red'>⛔ Límite alcanzado (" + cantidad + "/2)</font></html>");
            }
        } catch (Exception ex) {
            lblCiEstado.setText("<html><font color='red'>Error: " + ex.getMessage() + "</font></html>");
        }
    }

    private void reservarPuesto() {
        if (sectorSeleccionadoId == null) {
            JOptionPane.showMessageDialog(this, "Seleccione primero un sector.");
            return;
        }
        try {
            String puesto = txtPuesto.getText().trim();
            String json = String.format("{\"sector_id\":%d,\"puesto\":\"%s\"}", sectorSeleccionadoId, esc(puesto));
            HttpResponse<String> resp = post("/api/bloqueos", json, token);
            if (resp.statusCode() == 200) {
                puestoReservado = true;
                JOptionPane.showMessageDialog(this, "Puesto reservado por 5 minutos.");
            } else {
                puestoReservado = false;
                JOptionPane.showMessageDialog(this, extraerCampo(resp.body(), "error"), "No disponible", JOptionPane.WARNING_MESSAGE);
            }
            actualizarResumen();
        } catch (Exception ex) {
            JOptionPane.showMessageDialog(this, "Error: " + ex.getMessage());
        }
    }

    private void actualizarResumen() {
        lblResumen.setText("<html>Comprador: " + txtNombre.getText() + " (" + txtCi.getText() + ")<br>"
                + "Sector: " + sectorSeleccionadoNombre + "<br>"
                + "Puesto: " + (puestoReservado ? txtPuesto.getText() : "— no reservado") + "<br>"
                + "Precio: Bs " + sectorSeleccionadoPrecio + "</html>");
    }

    private void registrarVenta() {
        if (!compradorValido) { JOptionPane.showMessageDialog(this, "Busque y valide la C.I. primero."); return; }
        if (sectorSeleccionadoId == null || !puestoReservado) { JOptionPane.showMessageDialog(this, "Reserve un puesto primero."); return; }
        if (!chkCedula.isSelected() || !chkLuz.isSelected() || !chkImpuestos.isSelected()) {
            JOptionPane.showMessageDialog(this, "Debe validar el checklist de documentación completo.");
            return;
        }
        try {
            String json = String.format(
                "{\"ci\":\"%s\",\"nombre\":\"%s\",\"telefono\":\"%s\",\"sector_id\":%d,\"puesto\":\"%s\"," +
                "\"checklist\":{\"cedula\":true,\"facturaLuz\":true,\"impuestos\":true}}",
                esc(txtCi.getText().trim()), esc(txtNombre.getText().trim()), esc(txtTelefono.getText().trim()),
                sectorSeleccionadoId, esc(txtPuesto.getText().trim()));
            HttpResponse<String> resp = post("/api/entradas", json, token);
            if (resp.statusCode() == 201) {
                String codigo = extraerCampo(resp.body(), "codigo_validacion");
                JOptionPane.showMessageDialog(this,
                        "Venta registrada.\nCódigo de validación (QR): " + codigo +
                        "\n\n(En la impresora térmica se emite el ticket físico con el QR.)",
                        "Venta exitosa", JOptionPane.INFORMATION_MESSAGE);
                // reset
                txtCi.setText(""); txtNombre.setText(""); txtTelefono.setText(""); txtPuesto.setText("");
                chkCedula.setSelected(false); chkLuz.setSelected(false); chkImpuestos.setSelected(false);
                sectorSeleccionadoId = null; puestoReservado = false; compradorValido = false;
                lblCiEstado.setText(" ");
                cargarSectores();
                actualizarResumen();
            } else {
                JOptionPane.showMessageDialog(this, extraerCampo(resp.body(), "error"), "Venta rechazada", JOptionPane.ERROR_MESSAGE);
            }
        } catch (Exception ex) {
            JOptionPane.showMessageDialog(this, "Error: " + ex.getMessage());
        }
    }

    // -------------------------------------------------------------------
    // HTTP helpers
    // -------------------------------------------------------------------
    private HttpResponse<String> get(String path) throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder().uri(URI.create(baseUrl + path)).GET();
        if (token != null) b.header("Authorization", "Bearer " + token);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String path, String json, String tok) throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder().uri(URI.create(baseUrl + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json));
        if (tok != null) b.header("Authorization", "Bearer " + tok);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    // -------------------------------------------------------------------
    // Parsing JSON minimalista (sin dependencias externas)
    // -------------------------------------------------------------------
    private String esc(String s) { return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\""); }

    private String extraerCampo(String json, String campo) {
        Matcher m = Pattern.compile("\"" + campo + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        if (m.find()) return m.group(1);
        Matcher m2 = Pattern.compile("\"" + campo + "\"\\s*:\\s*(true|false|null|[0-9.]+)").matcher(json);
        if (m2.find()) return m2.group(1);
        return "";
    }

    private String extraerCampoNumero(String json, String campo) {
        Matcher m = Pattern.compile("\"" + campo + "\"\\s*:\\s*([0-9.]+)").matcher(json);
        return m.find() ? m.group(1) : "0";
    }

    /** Parser mínimo de un array JSON plano de objetos (sin arrays/objetos anidados). */
    private List<Map<String, String>> parseArrayOfObjects(String json) {
        List<Map<String, String>> out = new java.util.ArrayList<>();
        Matcher objMatcher = Pattern.compile("\\{[^{}]*\\}").matcher(json);
        while (objMatcher.find()) {
            String obj = objMatcher.group();
            Map<String, String> map = new java.util.LinkedHashMap<>();
            Matcher fieldMatcher = Pattern.compile("\"(\\w+)\"\\s*:\\s*(\"([^\"]*)\"|[-0-9.truefalsnul]+)").matcher(obj);
            while (fieldMatcher.find()) {
                String key = fieldMatcher.group(1);
                String val = fieldMatcher.group(3) != null ? fieldMatcher.group(3) : fieldMatcher.group(2);
                map.put(key, val);
            }
            out.add(map);
        }
        return out;
    }

    public static void main(String[] args) {
        String baseUrl = args.length > 0 ? args[0] : "http://localhost:3000";
        SwingUtilities.invokeLater(() -> new Main(baseUrl).setVisible(true));
    }
}
