#include <pebble.h>

#define MAX_ITEMS 32
#define MAX_ENTITY_LEN 64
#define MAX_NAME_LEN 32
#define MAX_STATE_LEN 16
#define LEGACY_ICON_LEN 8
#define STATUS_LEN 48
#define PERSIST_KEY_ITEM_COUNT 1
#define PERSIST_KEY_ITEM_BASE 100

typedef struct {
  char entity[MAX_ENTITY_LEN];
  char name[MAX_NAME_LEN];
  char state[MAX_STATE_LEN];
  bool state_pending;
  bool busy;
} HAItem;

typedef struct {
  char name[MAX_NAME_LEN];
  // Keeps the persisted cache layout from versions that stored item icons.
  char legacy_icon[LEGACY_ICON_LEN];
} HACachedItem;

static Window *s_window;
static MenuLayer *s_menu_layer;

static HAItem s_items[MAX_ITEMS];
static uint16_t s_item_count;
static char s_status[STATUS_LEN];
static bool s_loading = true;
static bool s_settings_needed;
static AppTimer *s_spinner_timer;
static uint8_t s_spinner_index;

static bool prv_has_spinners(void);
static void prv_schedule_spinner(void);

static void prv_clear_item(HAItem *item) {
  item->entity[0] = '\0';
  item->name[0] = '\0';
  item->state[0] = '\0';
  item->state_pending = false;
  item->busy = false;
}

static void prv_apply_item_defaults(HAItem *item) {
  if (item->name[0] == '\0') {
    snprintf(item->name, sizeof(item->name), "%.*s", (int)sizeof(item->name) - 1, item->entity[0] ? item->entity : "Item");
  }
}

static void prv_persist_item(uint16_t index) {
  if (index >= MAX_ITEMS) {
    return;
  }

  HACachedItem cached = {0};
  snprintf(cached.name, sizeof(cached.name), "%s", s_items[index].name);
  persist_write_data(PERSIST_KEY_ITEM_BASE + index, &cached, sizeof(cached));
}

static void prv_persist_item_count(void) {
  persist_write_int(PERSIST_KEY_ITEM_COUNT, s_item_count);
}

static void prv_load_cached_items(void) {
  if (!persist_exists(PERSIST_KEY_ITEM_COUNT)) {
    return;
  }

  int count = persist_read_int(PERSIST_KEY_ITEM_COUNT);
  if (count < 0) {
    count = 0;
  } else if (count > MAX_ITEMS) {
    count = MAX_ITEMS;
  }

  s_item_count = count;
  s_loading = false;

  for (uint16_t i = 0; i < s_item_count; i++) {
    HACachedItem cached;
    prv_clear_item(&s_items[i]);
    if (persist_read_data(PERSIST_KEY_ITEM_BASE + i, &cached, sizeof(cached)) == (int)sizeof(cached)) {
      snprintf(s_items[i].name, sizeof(s_items[i].name), "%s", cached.name);
    }
    s_items[i].state_pending = true;
    prv_apply_item_defaults(&s_items[i]);
  }
}

static void prv_set_status(const char *status) {
  if (!status) {
    status = "";
  }

  snprintf(s_status, sizeof(s_status), "%s", status);
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
  prv_schedule_spinner();
}

static void prv_send_action(const char *action, int index) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    prv_set_status("Phone unavailable");
    return;
  }

  dict_write_cstring(iter, MESSAGE_KEY_Action, action);
  if (index >= 0 && index < (int)s_item_count) {
    dict_write_int(iter, MESSAGE_KEY_Index, &index, sizeof(index), true);
    dict_write_cstring(iter, MESSAGE_KEY_Entity, s_items[index].entity);
  }

  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    prv_set_status("Send failed");
  }
}

static uint16_t prv_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *context) {
  return s_item_count > 0 ? s_item_count : 1;
}

static const char *prv_spinner_text(void) {
  static const char *frames[] = { "|", "/", "-", "\\" };
  return frames[s_spinner_index % 4];
}

static bool prv_has_spinners(void) {
  for (uint16_t i = 0; i < s_item_count; i++) {
    if (s_items[i].busy || s_items[i].state_pending) {
      return true;
    }
  }
  return false;
}

static void prv_spinner_timer_callback(void *context) {
  s_spinner_timer = NULL;
  s_spinner_index++;
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
  prv_schedule_spinner();
}

static void prv_schedule_spinner(void) {
  if (!s_spinner_timer && prv_has_spinners()) {
    s_spinner_timer = app_timer_register(250, prv_spinner_timer_callback, NULL);
  }
}

static void prv_draw_row_callback(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *context) {
  GRect bounds = layer_get_bounds(cell_layer);
  bool highlighted = menu_cell_layer_is_highlighted(cell_layer);

  graphics_context_set_fill_color(ctx, highlighted ? GColorBlack : GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, highlighted ? GColorWhite : GColorBlack);
  graphics_context_set_stroke_color(ctx, highlighted ? GColorWhite : GColorBlack);

  if (s_item_count == 0) {
    const int16_t inset = 8;
    const char *title = s_loading ? "Loading..." : (s_settings_needed ? "No Settings" : "No Items");
    const char *message = s_loading ? s_status : (s_settings_needed ? "Open HASC app settings in the Pebble mobile app." : s_status);
    GRect title_frame = GRect(inset, bounds.size.h / 2 - 42, bounds.size.w - inset * 2, 32);
    GRect message_frame = GRect(inset, bounds.size.h / 2 - 8, bounds.size.w - inset * 2, 72);
    graphics_draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), title_frame, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    graphics_draw_text(ctx, message, fonts_get_system_font(FONT_KEY_GOTHIC_18), message_frame, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }

  HAItem *item = &s_items[cell_index->row];
  const char *status = item->busy || item->state_pending ? prv_spinner_text() : item->state;
  GRect name_frame = GRect(6, 3, bounds.size.w - 50, 24);
  GRect status_frame = GRect(bounds.size.w - 43, 9, 38, 24);

  graphics_draw_text(ctx, item->name, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), name_frame, GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, status, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), status_frame, GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}

static int16_t prv_get_cell_height_callback(struct MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  if (s_item_count == 0) {
    return layer_get_bounds(menu_layer_get_layer(menu_layer)).size.h;
  }
  return 44;
}

static void prv_select_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  if (s_item_count == 0 || cell_index->row >= s_item_count) {
    prv_send_action("sync", -1);
    return;
  }

  s_items[cell_index->row].busy = true;
  menu_layer_reload_data(s_menu_layer);
  prv_schedule_spinner();
  prv_send_action("single", cell_index->row);
}

static void prv_select_long_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  if (s_item_count == 0 || cell_index->row >= s_item_count) {
    prv_send_action("sync", -1);
    return;
  }

  s_items[cell_index->row].busy = true;
  menu_layer_reload_data(s_menu_layer);
  prv_schedule_spinner();
  prv_send_action("long", cell_index->row);
}

static void prv_update_item(DictionaryIterator *iter) {
  Tuple *index_tuple = dict_find(iter, MESSAGE_KEY_Index);
  if (!index_tuple) {
    return;
  }

  int index = index_tuple->value->int32;
  if (index < 0 || index >= MAX_ITEMS) {
    return;
  }

  if (index >= (int)s_item_count) {
    s_item_count = index + 1;
  }

  HAItem *item = &s_items[index];
  Tuple *entity_tuple = dict_find(iter, MESSAGE_KEY_Entity);
  Tuple *name_tuple = dict_find(iter, MESSAGE_KEY_Name);
  Tuple *state_tuple = dict_find(iter, MESSAGE_KEY_State);
  Tuple *state_pending_tuple = dict_find(iter, MESSAGE_KEY_StatePending);

  if (entity_tuple) {
    snprintf(item->entity, sizeof(item->entity), "%s", entity_tuple->value->cstring);
  }
  if (name_tuple) {
    snprintf(item->name, sizeof(item->name), "%s", name_tuple->value->cstring);
  }
  if (state_tuple) {
    snprintf(item->state, sizeof(item->state), "%s", state_tuple->value->cstring);
  }
  if (state_pending_tuple) {
    item->state_pending = state_pending_tuple->value->int32 != 0;
  } else if (state_tuple) {
    item->state_pending = item->state[0] == '\0';
  }
  prv_apply_item_defaults(item);
  item->busy = false;
  prv_persist_item(index);
}

static void prv_inbox_received_callback(DictionaryIterator *iter, void *context) {
  Tuple *count_tuple = dict_find(iter, MESSAGE_KEY_ItemCount);
  if (count_tuple) {
    int count = count_tuple->value->int32;
    if (count < 0) {
      count = 0;
    } else if (count > MAX_ITEMS) {
      count = MAX_ITEMS;
    }

    s_item_count = count;
    if (s_item_count > 0) {
      s_settings_needed = false;
    }
    for (uint16_t i = 0; i < MAX_ITEMS; i++) {
      s_items[i].state[0] = '\0';
      s_items[i].state_pending = true;
      s_items[i].busy = false;
      if (i >= s_item_count) {
        prv_clear_item(&s_items[i]);
      }
    }
    s_loading = false;
    prv_persist_item_count();
  }

  prv_update_item(iter);

  Tuple *status_tuple = dict_find(iter, MESSAGE_KEY_Status);
  if (status_tuple) {
    snprintf(s_status, sizeof(s_status), "%s", status_tuple->value->cstring);
    s_loading = false;
  }

  Tuple *settings_needed_tuple = dict_find(iter, MESSAGE_KEY_SettingsNeeded);
  if (settings_needed_tuple) {
    s_settings_needed = settings_needed_tuple->value->int32 != 0;
  }

  Tuple *error_tuple = dict_find(iter, MESSAGE_KEY_Error);
  if (error_tuple) {
    snprintf(s_status, sizeof(s_status), "%s", error_tuple->value->cstring);
    s_loading = false;
  }

  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
  prv_schedule_spinner();
}

static void prv_inbox_dropped_callback(AppMessageResult reason, void *context) {
  prv_set_status("Message dropped");
}

static void prv_outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  prv_set_status("Phone unavailable");
}

static void prv_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_menu_layer = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_rows = prv_get_num_rows_callback,
    .draw_row = prv_draw_row_callback,
    .get_cell_height = prv_get_cell_height_callback,
    .select_click = prv_select_callback,
    .select_long_click = prv_select_long_callback,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));
}

static void prv_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
}

static void prv_init(void) {
  snprintf(s_status, sizeof(s_status), "%s", "Waiting for phone");
  prv_load_cached_items();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  const bool animated = true;
  window_stack_push(s_window, animated);
  prv_schedule_spinner();

  app_message_register_inbox_received(prv_inbox_received_callback);
  app_message_register_inbox_dropped(prv_inbox_dropped_callback);
  app_message_register_outbox_failed(prv_outbox_failed_callback);
  app_message_open(512, 128);
  prv_send_action("sync", -1);
}

static void prv_deinit(void) {
  if (s_spinner_timer) {
    app_timer_cancel(s_spinner_timer);
  }
  window_destroy(s_window);
}

int main(void) {
  prv_init();

  APP_LOG(APP_LOG_LEVEL_DEBUG, "Done initializing, pushed window: %p", s_window);

  app_event_loop();
  prv_deinit();
}
