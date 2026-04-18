-- Полнотекстовый поиск (FTS5) для Person и Event.
-- Поддерживается кириллица и поиск по подстроке.

CREATE VIRTUAL TABLE IF NOT EXISTS person_fts USING fts5(
  personId UNINDEXED,
  fullName,
  phone,
  passportNumber,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  eventId UNINDEXED,
  title,
  location,
  program,
  tokenize = "unicode61 remove_diacritics 2"
);

-- Триггеры синхронизации Person -> person_fts
CREATE TRIGGER IF NOT EXISTS person_ai AFTER INSERT ON Person BEGIN
  INSERT INTO person_fts (personId, fullName, phone, passportNumber)
  VALUES (
    NEW.id,
    TRIM(COALESCE(NEW.lastName,'') || ' ' || COALESCE(NEW.firstName,'') || ' ' || COALESCE(NEW.middleName,'')),
    COALESCE(NEW.phone,''),
    COALESCE(NEW.passportNumber,'')
  );
END;

CREATE TRIGGER IF NOT EXISTS person_ad AFTER DELETE ON Person BEGIN
  DELETE FROM person_fts WHERE personId = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS person_au AFTER UPDATE ON Person BEGIN
  DELETE FROM person_fts WHERE personId = OLD.id;
  INSERT INTO person_fts (personId, fullName, phone, passportNumber)
  VALUES (
    NEW.id,
    TRIM(COALESCE(NEW.lastName,'') || ' ' || COALESCE(NEW.firstName,'') || ' ' || COALESCE(NEW.middleName,'')),
    COALESCE(NEW.phone,''),
    COALESCE(NEW.passportNumber,'')
  );
END;

-- Триггеры синхронизации Event -> event_fts
CREATE TRIGGER IF NOT EXISTS event_ai AFTER INSERT ON Event BEGIN
  INSERT INTO event_fts (eventId, title, location, program)
  VALUES (NEW.id, COALESCE(NEW.title,''), COALESCE(NEW.location,''), COALESCE(NEW.program,''));
END;

CREATE TRIGGER IF NOT EXISTS event_ad AFTER DELETE ON Event BEGIN
  DELETE FROM event_fts WHERE eventId = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS event_au AFTER UPDATE ON Event BEGIN
  DELETE FROM event_fts WHERE eventId = OLD.id;
  INSERT INTO event_fts (eventId, title, location, program)
  VALUES (NEW.id, COALESCE(NEW.title,''), COALESCE(NEW.location,''), COALESCE(NEW.program,''));
END;
