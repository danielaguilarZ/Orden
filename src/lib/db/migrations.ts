import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Migraciones en orden. Nunca edites una ya publicada: añade otra nueva.
 * Los datos de dominio flexibles (paneles, muebles, apariencia…) van en
 * columnas JSON para que un tipo nuevo no exija cambiar el esquema.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "base",
    up: (db) => {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          specialty TEXT NOT NULL DEFAULT '',
          instructions TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT 'haiku',
          personality TEXT NOT NULL DEFAULT '{}',
          appearance TEXT NOT NULL DEFAULT '{}',
          ambient TEXT NOT NULL DEFAULT '[]',
          is_chief INTEGER NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'idle',
          status_text TEXT NOT NULL DEFAULT '',
          room_id TEXT,
          session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE rooms (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          w INTEGER NOT NULL,
          d INTEGER NOT NULL,
          style TEXT NOT NULL DEFAULT '{}',
          furniture TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Bus de eventos para el tiempo real (web <- worker). Se purga solo.
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );

        CREATE TABLE heartbeats (
          name TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          info TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX activity_created ON activity(created_at);
      `);
    },
  },
  {
    version: 2,
    name: "encargos-y-chat",
    up: (db) => {
      db.exec(`
        -- Una conversación por agente (se puede reiniciar). Guarda la sesión del SDK.
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT '',
          session_id TEXT,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX conversations_agent ON conversations(agent_id, archived);

        -- Encargos: lo que ejecuta el worker (chat, delegación, rutina…).
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          result TEXT,
          error TEXT,
          created_by TEXT NOT NULL DEFAULT 'user',
          data TEXT NOT NULL DEFAULT '{}',
          usage TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX tasks_status ON tasks(status, created_at);
        CREATE INDEX tasks_parent ON tasks(parent_id);
        CREATE INDEX tasks_agent ON tasks(agent_id, status);

        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          agent_id TEXT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          task_id TEXT,
          data TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX messages_conv ON messages(conversation_id, created_at);
      `);
    },
  },
  {
    version: 3,
    name: "paneles",
    up: (db) => {
      db.exec(`
        -- Paneles genéricos: el contenido va en data (JSON) según su tipo.
        CREATE TABLE panels (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}',
          layout TEXT NOT NULL DEFAULT '{}',
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          version INTEGER NOT NULL DEFAULT 1,
          archived INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT 'user',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX panels_updated ON panels(archived, updated_at);

        -- Historial: instantánea del estado ANTERIOR a cada encargo o edición manual.
        CREATE TABLE panel_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          data TEXT NOT NULL,
          actor TEXT NOT NULL,
          task_id TEXT,
          reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX panel_versions_panel ON panel_versions(panel_id, id);
      `);
    },
  },
  {
    version: 4,
    name: "memoria",
    up: (db) => {
      db.exec(`
        -- Perfil de vida compartido por todos los agentes.
        CREATE TABLE memory (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'user',
          version INTEGER NOT NULL DEFAULT 1,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX memory_category ON memory(archived, category);

        -- Búsqueda de texto completo (sin tildes, por prefijos).
        CREATE VIRTUAL TABLE memory_fts USING fts5(
          title, content, tags, category UNINDEXED,
          content='memory', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
          INSERT INTO memory_fts(rowid, title, content, tags, category) VALUES (new.rowid, new.title, new.content, new.tags, new.category);
        END;
        CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, title, content, tags, category) VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.category);
        END;
        CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, title, content, tags, category) VALUES ('delete', old.rowid, old.title, old.content, old.tags, old.category);
          INSERT INTO memory_fts(rowid, title, content, tags, category) VALUES (new.rowid, new.title, new.content, new.tags, new.category);
        END;

        CREATE TABLE memory_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL,
          archived INTEGER NOT NULL,
          actor TEXT NOT NULL,
          task_id TEXT,
          reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX memory_versions_mem ON memory_versions(memory_id, id);
      `);
    },
  },
  {
    version: 5,
    name: "rutinas",
    up: (db) => {
      db.exec(`
        CREATE TABLE routines (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          next_run_at TEXT,
          last_task_id TEXT,
          created_by TEXT NOT NULL DEFAULT 'user',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX routines_due ON routines(enabled, next_run_at);
        CREATE INDEX activity_agent ON activity(agent_id, created_at);
      `);
    },
  },
  {
    version: 6,
    name: "huella-del-prompt",
    up: (db) => {
      // Si el prompt de sistema cambia (agente editado), no se reanuda la sesión vieja.
      db.exec("ALTER TABLE conversations ADD COLUMN prompt_hash TEXT");
    },
  },
  {
    version: 7,
    name: "rol-admin",
    up: (db) => {
      db.exec(`
        -- Agentes con permiso para modificar el código de Orden (en una copia aparte).
        ALTER TABLE agents ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;

        -- Propuestas de cambios de código: el usuario las aplica o las descarta.
        CREATE TABLE code_changes (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          branch TEXT NOT NULL,
          worktree TEXT NOT NULL,
          base TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          files TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pendiente',
          log TEXT NOT NULL DEFAULT '',
          task_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX code_changes_agent ON code_changes(agent_id, status);
      `);
    },
  },
  {
    version: 8,
    name: "salas-compartidas",
    up: (db) => {
      // Sala en la que está ahora el agente (null = la suya). Cualquier agente
      // puede estar y trabajar en cualquier sala; room_id sigue siendo su dueño.
      db.exec("ALTER TABLE agents ADD COLUMN location_room_id TEXT");
    },
  },
  {
    version: 9,
    name: "edificios",
    up: (db) => {
      // Cada sala pertenece a un edificio (por defecto, la casa de Orden). Los
      // edificios están separados y unidos por una pasarela. Las existentes, a Orden.
      db.exec("ALTER TABLE rooms ADD COLUMN building TEXT NOT NULL DEFAULT 'orden'");
    },
  },
  {
    version: 10,
    name: "escritorio-asignado",
    up: (db) => {
      // Los agentes nuevos no tienen sala propia: tienen un escritorio en una
      // sala común (room_id). Aquí se guarda el id de la silla de su puesto.
      // Los existentes (con sala propia) lo dejan a null y no cambian.
      db.exec("ALTER TABLE agents ADD COLUMN desk_seat_id TEXT");
    },
  },
  {
    version: 11,
    name: "conexiones",
    up: (db) => {
      db.exec(`
        -- Servicios externos (GitHub…) a los que pueden acceder los agentes.
        -- secret: credencial cifrada (AES-256-GCM); nunca se guarda en claro.
        CREATE TABLE connections (
          id TEXT PRIMARY KEY,
          service TEXT NOT NULL,
          name TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          auth TEXT NOT NULL DEFAULT 'auto',
          secret TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          status_panel_id TEXT,
          last_sync_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Qué agente puede usar cada conexión y con qué nivel.
        CREATE TABLE connection_grants (
          connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          level TEXT NOT NULL,
          PRIMARY KEY (connection_id, agent_id)
        );
      `);
    },
  },
  {
    version: 12,
    name: "papelera-de-salas",
    up: (db) => {
      // Borrar una sala desde el editor la manda a la papelera (se puede
      // recuperar). Con fecha = archivada; null = en uso.
      db.exec("ALTER TABLE rooms ADD COLUMN archived_at TEXT");
    },
  },
  {
    version: 13,
    name: "archivos",
    up: (db) => {
      db.exec(`
        -- Sección «Archivos» (dentro de Paneles): árbol de carpetas y archivos.
        -- El contenido de cada archivo está en disco con su id como nombre
        -- (<carpeta de datos>/archivos/blobs/<id>); el nombre visible solo vive aquí.
        -- private: 1 = solo la ven los agentes con acceso a todo (y el usuario).
        -- trashed_at: con fecha = en la papelera (y todo lo que cuelga de él).
        CREATE TABLE file_nodes (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES file_nodes(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          mime TEXT NOT NULL DEFAULT '',
          private INTEGER NOT NULL DEFAULT 0,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          trashed_at TEXT
        );
        CREATE INDEX file_nodes_parent ON file_nodes(parent_id);

        -- Agentes con acceso a TODOS los archivos (incluidas carpetas privadas).
        -- El jefe lo tiene siempre; el resto solo ve las carpetas compartidas.
        CREATE TABLE file_access (
          agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
          level TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 14,
    name: "propuestas",
    up: (db) => {
      db.exec(`
        -- Pestaña «Propuestas»: ideas de los agentes (sobre todo Zen) que el
        -- usuario acepta, rechaza o aplaza. status: pendiente | aceptada |
        -- en_curso | hecha | rechazada. postponed_until: aplazada hasta esa
        -- fecha (sigue pendiente pero no cuenta). task_id: encargo que avisa a
        -- Zen de que la ejecute (null = aún no avisado). source: origen (p. ej.
        -- «kanban:<panel>:<tarjeta>») para no importar dos veces.
        CREATE TABLE proposals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          scope TEXT NOT NULL,
          priority TEXT NOT NULL,
          impact TEXT NOT NULL,
          effort TEXT NOT NULL,
          author_id TEXT,
          author_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pendiente',
          reject_reason TEXT,
          result_note TEXT,
          postponed_until TEXT,
          task_id TEXT,
          source TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          decided_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX proposals_status ON proposals(status);
        CREATE UNIQUE INDEX proposals_source ON proposals(source) WHERE source IS NOT NULL;
      `);
    },
  },
];
