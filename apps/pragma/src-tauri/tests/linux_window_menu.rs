//! Exercises the Linux replacement using real native menu objects, including on
//! macOS. No Pragma server, webview, or dev server is started.

#[path = "../src/window_menu.rs"]
mod window_menu;

use tauri::menu::{Menu, MenuItem, MenuItemKind, Submenu, WINDOW_SUBMENU_ID};

fn main() {
    // Linux CI may have no display server. Run under xvfb-run to exercise GTK.
    if cfg!(target_os = "linux")
        && std::env::var_os("DISPLAY").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_none()
    {
        eprintln!("SKIP linux_window_menu: no display; run under xvfb-run");
        return;
    }
    let mut native_app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build native menu test app");
    let handle = native_app.handle().clone();
    let app = &handle;
    let menu = Menu::default(app).unwrap();
    let before: Vec<_> = menu
        .items()
        .unwrap()
        .iter()
        .map(|item| item.id().clone())
        .collect();
    window_menu::install(app, &menu).unwrap();
    let after: Vec<_> = menu
        .items()
        .unwrap()
        .iter()
        .map(|item| item.id().clone())
        .collect();
    assert_eq!(
        before, after,
        "replacement preserves all top-level menu positions"
    );
    assert_window_items(&menu);

    // Reinstalling must not duplicate the submenu or its actions.
    window_menu::install(app, &menu).unwrap();
    assert_eq!(menu.items().unwrap().len(), before.len());
    assert_window_items(&menu);

    // Also cover a menu with no default Window entry.
    let menu = Menu::new(app).unwrap();
    let other = MenuItem::with_id(app, "other.action", "Other action", true, None::<&str>).unwrap();
    menu.append(&Submenu::with_id_and_items(app, "other", "Other", true, &[&other]).unwrap())
        .unwrap();
    window_menu::install(app, &menu).unwrap();
    assert_eq!(menu.items().unwrap().len(), 2);
    assert_window_items(&menu);

    assert!(!window_menu::handle(app, "tabs.close-active", "main"));
    assert!(!window_menu::handle(app, "window.new-mini", "main"));
    // No windows exist: known events are still consumed without panicking.
    for id in ["window.minimize", "window.maximize", "window.close"] {
        assert!(window_menu::handle(app, id, "main"));
    }
    #[cfg(target_os = "linux")]
    assert_gtk_popup(&mut native_app);
    // Keep the binding mutable on every platform: Linux pumps native events.
    #[cfg(not(target_os = "linux"))]
    let _ = &mut native_app;
    println!("PASS linux_window_menu: real native items, replacement, ordering, event isolation");
}

fn assert_window_items(menu: &Menu<tauri::Wry>) {
    let submenu = menu.get(WINDOW_SUBMENU_ID).unwrap();
    let submenu = submenu.as_submenu().unwrap();
    assert_eq!(submenu.text().unwrap(), "Window");
    let items = submenu.items().unwrap();
    assert_eq!(items.len(), 3);
    for (item, (id, text)) in items.iter().zip([
        ("window.minimize", "Minimize"),
        ("window.maximize", "Maximize / Restore"),
        ("window.close", "Close Window"),
    ]) {
        // This is the regression: predefined items disappear in GTK. Merely
        // checking the submenu's length on macOS would not detect that mistake.
        let MenuItemKind::MenuItem(item) = item else {
            panic!("{id} must be an ordinary GTK-supported menu item");
        };
        assert_eq!(item.id().as_ref(), id);
        assert_eq!(item.text().unwrap(), text);
        assert!(item.is_enabled().unwrap());
    }
}

#[cfg(target_os = "linux")]
// A bounded event pump, not a busy-loop: flush queued native menu attachment and
// popup operations without running Pragma or leaving a test application alive.
#[allow(deprecated)]
fn assert_gtk_popup(app: &mut tauri::App) {
    use gtk::prelude::*;

    let window = tauri::WindowBuilder::new(app.handle(), "menu-test")
        .title("Pragma native menu regression")
        .build()
        .unwrap();
    let menu = Menu::default(app.handle()).unwrap();
    window_menu::install(app.handle(), &menu).unwrap();
    window.set_menu(menu).unwrap();
    for _ in 0..5 {
        app.run_iteration(|_, _| {});
    }
    let native_window = window.gtk_window().unwrap();
    let popup = find_gtk_window_menu(native_window.upcast_ref()).expect("GTK Window submenu");
    popup.popup_easy(0, gtk::current_event_time());
    for _ in 0..5 {
        app.run_iteration(|_, _| {});
    }
    let children = popup.children();
    assert_eq!(children.len(), 3, "GTK must not silently omit the items");
    for (child, expected) in children
        .iter()
        .zip(["Minimize", "Maximize / Restore", "Close Window"])
    {
        assert!(child.is_visible(), "{expected} must render in the popup");
        assert!(child.is_sensitive(), "{expected} must be enabled");
        assert_eq!(gtk_label(child).as_deref(), Some(expected));
    }
    popup.popdown();
}

#[cfg(target_os = "linux")]
fn find_gtk_window_menu(widget: &gtk::Widget) -> Option<gtk::Menu> {
    use gtk::prelude::*;

    if let Ok(item) = widget.clone().downcast::<gtk::MenuItem>() {
        if gtk_label(widget).as_deref() == Some("Window") {
            return item.submenu().and_then(|widget| widget.downcast().ok());
        }
    }
    widget
        .clone()
        .downcast::<gtk::Container>()
        .ok()?
        .children()
        .iter()
        .find_map(find_gtk_window_menu)
}

#[cfg(target_os = "linux")]
fn gtk_label(widget: &gtk::Widget) -> Option<String> {
    use gtk::prelude::*;

    // muda nests submenu titles inside GtkBox / GtkAccelLabel rather than
    // setting GtkMenuItem::label, so inspect the actual child label too.
    if let Ok(label) = widget.clone().downcast::<gtk::Label>() {
        return Some(label.text().to_string());
    }
    widget
        .clone()
        .downcast::<gtk::Container>()
        .ok()?
        .children()
        .iter()
        .find_map(gtk_label)
}
